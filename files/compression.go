package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/mholt/archives"
	"github.com/nwaples/rardecode/v2"
	"github.com/pufferpanel/pufferpanel/v3/utils"
)

const PathSeparator = "/"

const (
	// Archive limits are security defaults independent of host capacity.
	maxArchiveBytes      int64 = 1 << 30
	maxExtractedBytes    int64 = 4 << 30
	maxExtractedFileSize int64 = 1 << 30
	maxArchiveEntries          = 100000
	maxArchivePathLength       = 4096
	maxArchiveDuration         = 10 * time.Minute
	maxRarDictionarySize int64 = 256 << 20
)

var ErrArchiveLimit = errors.New("archive exceeds extraction limit")

type ExtractOptions struct {
	FileServer   FileServer
	SourceFile   string
	TargetPath   string
	Filter       string
	SkipRoot     bool
	ForcedWalker archives.Extractor
}

func DetermineIfSingleRoot(sourceFS FileServer, sourceFile string) (bool, error) {
	root := ""
	entries := 0
	err := eachArchiveFile(sourceFS, sourceFile, nil, func(_ context.Context, info archives.FileInfo) error {
		entries++
		if entries > maxArchiveEntries {
			return ErrArchiveLimit
		}
		name, err := archivePath(info.NameInArchive)
		if err != nil || name == "" {
			return err
		}
		component := strings.Split(name, PathSeparator)[0]
		if root == "" {
			root = component
			return nil
		}
		if component != root {
			return errors.New("not single root")
		}
		return nil
	})
	return err == nil, err
}

func Extract(sourceFS FileServer, sourceFile string, targetFS FileServer, targetPath, filter string, skipRoot bool, forcedType archives.Extractor) error {
	if targetFS == nil {
		targetFS = sourceFS
	}
	if skipRoot {
		var err error
		skipRoot, err = DetermineIfSingleRoot(sourceFS, sourceFile)
		if err != nil {
			return err
		}
	}

	var entries int
	var extracted int64
	return eachArchiveFile(sourceFS, sourceFile, forcedType, func(ctx context.Context, info archives.FileInfo) error {
		entries++
		if entries > maxArchiveEntries {
			return ErrArchiveLimit
		}
		entryPath, err := archivePath(info.NameInArchive)
		if err != nil {
			return err
		}
		if entryPath == "" {
			return nil
		}
		if skipRoot {
			_, entryPath, _ = strings.Cut(entryPath, PathSeparator)
			if entryPath == "" {
				return nil
			}
		}
		if !utils.CompareWildcard(info.Name(), filter) {
			return nil
		}
		target, err := targetArchivePath(targetPath, entryPath)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return targetFS.MkdirAll(target, 0755)
		}
		if !info.Mode().IsRegular() || info.LinkTarget != "" {
			return nil
		}
		if info.Size() > maxExtractedFileSize || (info.Size() >= 0 && info.Size() > maxExtractedBytes-extracted) {
			return ErrArchiveLimit
		}
		if err := targetFS.MkdirAll(path.Dir(target), 0755); err != nil {
			return err
		}
		in, err := info.Open()
		if err != nil {
			return err
		}
		out, err := targetFS.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode()|0600)
		if err != nil {
			_ = in.Close()
			return err
		}
		remaining := maxExtractedBytes - extracted
		limit := min(maxExtractedFileSize, remaining) + 1
		n, copyErr := io.Copy(out, io.LimitReader(contextReader{Context: ctx, Reader: in}, limit))
		closeOutErr := out.Close()
		closeInErr := in.Close()
		extracted += n
		if copyErr != nil {
			return copyErr
		}
		if closeOutErr != nil {
			return closeOutErr
		}
		if closeInErr != nil {
			return closeInErr
		}
		if n > maxExtractedFileSize || n > remaining {
			return ErrArchiveLimit
		}
		return ctx.Err()
	})
}

type contextReader struct {
	context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func eachArchiveFile(sourceFS FileServer, sourceFile string, forcedType archives.Extractor, handle archives.FileHandler) error {
	source, err := sourceFS.Open(sourceFile)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if info.Size() > maxArchiveBytes {
		return ErrArchiveLimit
	}
	ctx, cancel := context.WithTimeout(context.Background(), maxArchiveDuration)
	defer cancel()
	reader := io.Reader(source)
	extractor := forcedType
	if extractor == nil {
		format, identified, err := archives.Identify(ctx, sourceFile, reader)
		if err != nil {
			return err
		}
		var ok bool
		extractor, ok = format.(archives.Extractor)
		if !ok {
			return fmt.Errorf("%s is not an archive", sourceFile)
		}
		reader = identified
	}
	extractor, err = cappedRarExtractor(extractor)
	if err != nil {
		return err
	}
	return extractor.Extract(ctx, reader, handle)
}

func cappedRarExtractor(extractor archives.Extractor) (archives.Extractor, error) {
	switch extractor := extractor.(type) {
	case archives.Rar:
		return newRarExtractor(extractor)
	case *archives.Rar:
		if extractor == nil {
			return nil, errors.New("forced RAR extractor is nil")
		}
		return newRarExtractor(*extractor)
	default:
		return extractor, nil
	}
}

// rarExtractor supplies rardecode's dictionary cap, which archives.Rar does not expose.
type rarExtractor struct {
	password string
}

func newRarExtractor(format archives.Rar) (rarExtractor, error) {
	if format.ContinueOnError {
		return rarExtractor{}, errors.New("forced RAR ContinueOnError is unsupported")
	}
	if format.Name != "" {
		return rarExtractor{}, errors.New("forced RAR Name is unsupported")
	}
	if format.FS != nil {
		return rarExtractor{}, errors.New("forced RAR FS is unsupported")
	}
	return rarExtractor{password: format.Password}, nil
}

func (extractor rarExtractor) Extract(ctx context.Context, source io.Reader, handle archives.FileHandler) error {
	reader, err := rardecode.NewReader(source, rardecode.MaxDictionarySize(maxRarDictionarySize), rardecode.Password(extractor.password))
	if err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		info := rarFileInfo{header: header}
		file := archives.FileInfo{
			FileInfo:      info,
			Header:        header,
			NameInArchive: header.Name,
			Open: func() (fs.File, error) {
				return rarArchiveFile{Reader: reader, info: info}, nil
			},
		}
		if err := handle(ctx, file); err != nil {
			return err
		}
	}
}

type rarFileInfo struct {
	header *rardecode.FileHeader
}

func (info rarFileInfo) Name() string       { return info.header.Name }
func (info rarFileInfo) Size() int64        { return info.header.UnPackedSize }
func (info rarFileInfo) Mode() os.FileMode  { return info.header.Mode() }
func (info rarFileInfo) ModTime() time.Time { return info.header.ModificationTime }
func (info rarFileInfo) IsDir() bool        { return info.header.IsDir }
func (info rarFileInfo) Sys() any           { return nil }

type rarArchiveFile struct {
	io.Reader
	info fs.FileInfo
}

func (file rarArchiveFile) Close() error               { return nil }
func (file rarArchiveFile) Stat() (fs.FileInfo, error) { return file.info, nil }

func Compress(sourceFS FileServer, targetFS FileServer, targetFile string, filenames []string) error {
	if len(filenames) == 0 {
		return errors.New("no files to compress")
	}
	ctx, cancel := context.WithTimeout(context.Background(), maxArchiveDuration)
	defer cancel()
	format, _, err := archives.Identify(ctx, targetFile, nil)
	if err != nil {
		return err
	}
	archiver, ok := format.(archives.Archiver)
	if !ok {
		return fmt.Errorf("%s is not an archive format", targetFile)
	}
	archiveFiles := make([]archives.FileInfo, 0)
	for _, filename := range filenames {
		name := strings.TrimPrefix(filepath.Clean("/"+filename), "/")
		archiveName := filepath.Base(name)
		if name == "" {
			archiveName = filepath.Base(filepath.Clean(sourceFS.Prefix()))
		}
		files, err := archiveFilesFromFS(sourceFS, name, archiveName)
		if err != nil {
			return err
		}
		archiveFiles = append(archiveFiles, files...)
	}
	out, err := targetFS.OpenFile(targetFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = archiver.Archive(ctx, out, archiveFiles)
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func archiveFilesFromFS(server FileServer, filename, archiveName string) ([]archives.FileInfo, error) {
	info, err := server.Lstat(filename)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlinkNotSupported
	}
	file := archives.FileInfo{FileInfo: info, NameInArchive: filepath.ToSlash(archiveName)}
	if !info.IsDir() {
		file.Open = func() (fs.File, error) { return server.Open(filename) }
		return []archives.FileInfo{file}, nil
	}
	entries := []archives.FileInfo{file}
	children, err := server.ReadDir(filename)
	if err != nil {
		return nil, err
	}
	for _, child := range children {
		childFiles, err := archiveFilesFromFS(server, filepath.Join(filename, child.Name()), path.Join(archiveName, child.Name()))
		if err != nil {
			return nil, err
		}
		entries = append(entries, childFiles...)
	}
	return entries, nil
}

func archivePath(name string) (string, error) {
	if name == "" {
		return "", nil
	}
	if len(name) > maxArchivePathLength || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || filepath.IsAbs(name) || (len(name) >= 2 && name[1] == ':') {
		return "", fmt.Errorf("invalid archive path %q", name)
	}
	for _, component := range strings.Split(name, PathSeparator) {
		if component == ".." {
			return "", fmt.Errorf("invalid archive path %q", name)
		}
	}
	cleaned := path.Clean(name)
	if cleaned == "." {
		return "", nil
	}
	return cleaned, nil
}

func targetArchivePath(targetPath, entryPath string) (string, error) {
	base, err := prepPath(targetPath)
	if err != nil {
		return "", err
	}
	return path.Join(base, entryPath), nil
}
