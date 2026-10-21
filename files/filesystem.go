package files

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/pufferpanel/pufferpanel/v3/sys"
	"github.com/pufferpanel/pufferpanel/v3/utils"
	"golang.org/x/sys/unix"
)

var ErrInvalidAccess = errors.New("invalid access")
var ErrSymlinkNotSupported = errors.New("symlinks are not supported")

type FileServer interface {
	fs.FS
	fs.ReadDirFS
	fs.StatFS

	Prefix() string
	GetRootFD() int

	Stat(name string) (fs.FileInfo, error)
	Mkdir(path string, mode os.FileMode) error
	MkdirAll(path string, mode os.FileMode) error
	OpenFile(path string, flags int, mode os.FileMode) (*os.File, error)
	Remove(path string) error
	Rename(source, target string) error
	RemoveAll(path string) error
	Glob(pattern string) ([]string, error)
	Symlink(oldname, newname string) error
	Lstat(name string) (fs.FileInfo, error)
	Chmod(path string, mode os.FileMode) error

	Create(name string) (*os.File, error)
	Copy(sourceFS FileServer, source, target string) error

	WriteFile(name string, content []byte, mode os.FileMode) error
	CreateTemp(dir, pattern string) (*os.File, error)
	ReadFile(name string) ([]byte, error)

	Close() error
}

type fileServer struct {
	dir      string
	root     *os.File
	confined *os.Root

	symlinkSupport bool
	uid            int
	gid            int
}

func NewFileServer(prefix string, uid, gid int, symlinkSupport bool) (FileServer, error) {
	f := &fileServer{dir: prefix, uid: uid, gid: gid}
	var err error
	f.confined, err = os.OpenRoot(prefix)
	if err != nil {
		return nil, err
	}
	f.root, err = f.confined.Open(".")
	if err != nil {
		_ = f.confined.Close()
		return nil, err
	}
	f.symlinkSupport = symlinkSupport
	return f, nil
}

func (sfp *fileServer) GetRootFD() int {
	return getFd(sfp.root)
}

func (sfp *fileServer) Prefix() string {
	return sfp.dir
}

func (sfp *fileServer) Open(name string) (fs.File, error) {
	return sfp.OpenFile(name, os.O_RDONLY, 0644)
}

func (sfp *fileServer) Stat(name string) (fs.FileInfo, error) {
	f, err := sfp.Open(name)
	if err != nil {
		return nil, err
	}
	defer utils.Close(f)
	return f.Stat()
}

func (sfp *fileServer) Symlink(oldpath, newpath string) error {
	return ErrSymlinkNotSupported
}

func (sfp *fileServer) ReadDir(name string) ([]fs.DirEntry, error) {
	folder, err := sfp.OpenFile(name, os.O_RDONLY, 0644)
	if err != nil {
		return nil, err
	}
	defer utils.Close(folder)

	return folder.ReadDir(0)
}

func (sfp *fileServer) Glob(pattern string) ([]string, error) {
	parent := filepath.Base(pattern)
	if parent == pattern {
		parent = "."
	}

	files, err := sfp.ReadDir(parent)

	if err != nil {
		return nil, err
	}

	results := make([]string, 0)
	for _, v := range files {
		if matches, _ := filepath.Match(pattern, v.Name()); matches {
			results = append(results, v.Name())
		}
	}
	return results, nil
}

func (sfp *fileServer) Close() error {
	err := sfp.root.Close()
	confinedErr := sfp.confined.Close()
	if err != nil {
		return err
	}
	return confinedErr
}

func (sfp *fileServer) OpenFile(path string, flags int, mode os.FileMode) (*os.File, error) {
	path, err := prepPath(path)
	if err != nil {
		return nil, err
	}

	//if this is not a create request, nuke mode
	if flags&os.O_CREATE == 0 {
		mode = 0
	}

	var fd int
	if path == "" {
		fd, err = unix.Openat(getFd(sfp.root), ".", flags, sys.SyscallMode(mode))
	} else if utils.UseOpenat2() {
		//at this point, we are going to work on openat2
		fd, err = unix.Openat2(getFd(sfp.root), path, &unix.OpenHow{
			Flags:   uint64(flags),
			Mode:    uint64(sys.SyscallMode(mode)),
			Resolve: unix.RESOLVE_BENEATH,
		})
		if err != nil {
			return nil, err
		}
	} else {
		//because openat is not permitted, we will have to play a game...
		parts := strings.Split(path, string(filepath.Separator))

		//follow the chain, this is just directories we're going through
		var rootFd = getFd(sfp.root)
		var previousFd = rootFd
		for _, v := range parts[:len(parts)-1] {
			fd, err = unix.Openat(previousFd, v, unix.O_NOFOLLOW|unix.O_PATH, sys.SyscallMode(0))
			if previousFd != rootFd {
				_ = unix.Close(previousFd)
			}
			if err != nil {
				return nil, err
			}
			previousFd = fd
		}
		//now.... we can open the file
		fd, err = unix.Openat(previousFd, parts[len(parts)-1], unix.O_NOFOLLOW|flags, sys.SyscallMode(mode))
		if previousFd != rootFd {
			_ = unix.Close(previousFd)
		}
		if err != nil {
			return nil, err
		}
	}

	if err != nil {
		return nil, err
	}

	file := os.NewFile(uintptr(fd), path)
	//if flags&os.O_CREATE == 1 && sfp.uid != -1 {
	//	err = file.Chown(sfp.uid, sfp.gid)
	//}
	return file, err
}

func (sfp *fileServer) MkdirAll(path string, mode os.FileMode) error {
	//this is going to be recursive...
	var err error
	path, err = prepPath(path)
	if err != nil {
		return err
	}

	//now for each one, we just need to make each path, and hope this works
	//in theory, the mkdir will be safe enough
	parts := strings.Split(path, string(filepath.Separator))
	//if it was just mkdir root... we don't do anything
	if len(parts) == 0 {
		return nil
	}

	for i := range parts {
		err = sfp.Mkdir(filepath.Join(parts[:i+1]...), mode)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	}

	return nil
}

func (sfp *fileServer) Rename(source, target string) error {
	source, err := prepPath(source)
	if err != nil {
		return err
	}
	target, err = prepPath(target)
	if err != nil {
		return err
	}

	sourceParent := filepath.Dir(source)
	targetParent := filepath.Dir(target)

	sourceName := filepath.Base(source)
	targetName := filepath.Base(target)

	sourceFolder, err := sfp.OpenFile(sourceParent, os.O_RDONLY, 0644)
	if err != nil {
		return err
	}
	defer utils.Close(sourceFolder)

	targetFolder, err := sfp.OpenFile(targetParent, os.O_RDONLY, 0644)
	if err != nil {
		return err
	}
	defer utils.Close(targetFolder)

	err = unix.Renameat2(getFd(sourceFolder), sourceName, getFd(targetFolder), targetName, 0)
	return err
}

func (sfp *fileServer) Mkdir(path string, mode os.FileMode) error {
	path, err := prepPath(path)
	if err != nil {
		return err
	}
	parent := filepath.Dir(path)
	f := filepath.Base(path)

	if parent == "" || parent == "." || parent == "/" {
		err = unix.Mkdirat(getFd(sfp.root), f, sys.SyscallMode(mode))
		if err != nil {
			return err
		}
		/*if sfp.uid != -1 {
			err = unix.Fchown(getFd(sfp.root), sfp.uid, sfp.gid)
		}*/

		return err
	} else {
		folder, err := sfp.OpenFile(parent, os.O_RDONLY, mode)
		if err != nil {
			return err
		}
		defer utils.Close(folder)
		err = unix.Mkdirat(getFd(folder), f, sys.SyscallMode(mode))
		if err != nil {
			return err
		}
		/*if sfp.uid != -1 {
			err = unix.Fchown(getFd(folder), sfp.uid, sfp.gid)
		}*/
		return err
	}
}

func (sfp *fileServer) Remove(path string) error {
	path, err := prepPath(path)
	if err != nil {
		return err
	}
	if path == "" {
		return ErrInvalidAccess
	}
	parent := filepath.Dir(path)
	name := filepath.Base(path)

	folder, err := sfp.OpenFile(parent, os.O_RDONLY, 0644)
	if err != nil {
		return err
	}
	defer utils.Close(folder)

	info, err := sfp.Lstat(path)
	if err != nil {
		return err
	}
	flags := 0
	if info.IsDir() {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(getFd(folder), name, flags)
}

func (sfp *fileServer) RemoveAll(path string) (err error) {
	defer func() {
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
	}()

	path, err = prepPath(path)
	if err != nil {
		return err
	}

	var folder *os.File
	folder, err = sfp.OpenFile(path, os.O_RDONLY, 0644)
	if err != nil {
		return err
	}
	defer utils.Close(folder)

	files, err := folder.ReadDir(0)
	if err != nil {
		return err
	}

	//go through all the files, and call our stuff to delete it
	for _, v := range files {
		if v.Type()&os.ModeSymlink == 0 && v.IsDir() {
			//recursive call, so we need to go into this one and delete things
			err = sfp.RemoveAll(filepath.Join(path, v.Name()))
			if err != nil {
				return err
			}
		} else {
			err = unix.Unlinkat(getFd(folder), v.Name(), 0)
			if err != nil {
				return err
			}
		}
	}

	err = sfp.Remove(path)
	return err
}

func (sfp *fileServer) Lstat(path string) (fs.FileInfo, error) {
	path, err := prepPath(path)
	if err != nil {
		return nil, err
	}
	if path == "" {
		path = "."
	}
	return sfp.confined.Lstat(path)
}

func (fp *fileServer) Chmod(path string, mode os.FileMode) error {
	file, err := fp.OpenFile(path, unix.O_PATH, 0)
	if err != nil {
		return err
	}
	defer utils.Close(file)

	err = unix.Fchmodat(getFd(file), "", sys.SyscallMode(mode), unix.AT_EMPTY_PATH)
	if !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EOPNOTSUPP) {
		return err
	}
	return unix.Fchmodat(unix.AT_FDCWD, fmt.Sprintf("/proc/self/fd/%d", getFd(file)), sys.SyscallMode(mode), 0)
}

func (sfp *fileServer) Copy(sourceFileServer FileServer, sourcePath, targetPath string) error {
	parent := filepath.Dir(filepath.Clean(targetPath))
	if parent != "/" && parent != "." && parent != "" {
		sfp.MkdirAll(parent, 0755)
	}

	sourceFile, err := sourceFileServer.Open(sourcePath)
	if err != nil {
		return err
	}
	defer utils.Close(sourceFile)

	targetFile, err := sfp.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer utils.Close(targetFile)

	_, err = io.Copy(targetFile, sourceFile)
	return err
}

func (sfp *fileServer) Create(name string) (*os.File, error) {
	return sfp.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
}

func (sfp *fileServer) WriteFile(name string, content []byte, mode os.FileMode) error {
	f, err := sfp.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(content)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	//the mode passed to open is masked by the process umask, so enforce the requested mode
	return sfp.Chmod(name, mode)
}

func (sfp *fileServer) CreateTemp(dir, pattern string) (*os.File, error) {
	dir, err := prepPath(dir)
	if err != nil {
		return nil, err
	}
	if strings.ContainsRune(pattern, filepath.Separator) {
		return nil, fmt.Errorf("%w: pattern contains path separator", fs.ErrInvalid)
	}

	prefix, suffix := pattern, ""
	if i := strings.LastIndex(pattern, "*"); i >= 0 {
		prefix, suffix = pattern[:i], pattern[i+1:]
	}
	for range 10000 {
		random := make([]byte, 8)
		if _, err := rand.Read(random); err != nil {
			return nil, err
		}
		file, err := sfp.OpenFile(filepath.Join(dir, prefix+hex.EncodeToString(random)+suffix), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
		if !errors.Is(err, os.ErrExist) {
			return file, err
		}
	}
	return nil, os.ErrExist
}

func (sfp *fileServer) ReadFile(name string) ([]byte, error) {
	file, err := sfp.Open(name)
	if err != nil {
		return nil, err
	}
	defer utils.Close(file)

	return io.ReadAll(file)
}

func getFd(f *os.File) int {
	return int(f.Fd())
}

func prepPath(path string) (string, error) {
	path = strings.TrimPrefix(filepath.Clean(path), "/")
	if path == "." {
		return "", nil
	}
	if path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
		return "", ErrInvalidAccess
	}
	return path, nil
}
