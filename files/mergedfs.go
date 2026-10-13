package files

import (
	"errors"
	"io/fs"
	"os"
)

type MergedFS struct {
	fileSystems []fs.FS
}

func NewMergedFS(systems ...fs.FS) *MergedFS {
	return &MergedFS{
		fileSystems: systems,
	}
}

type Filesystem interface {
	fs.FS
	fs.ReadDirFS
	fs.ReadFileFS
}

func (m *MergedFS) Open(name string) (fs.File, error) {
	var f fs.File
	var e error
	for _, fss := range m.fileSystems {
		f, e = fss.Open(name)
		if e == nil {
			return f, nil
		}
		if !os.IsNotExist(e) {
			return nil, e
		}
	}
	return f, e
}

func (m *MergedFS) ReadDir(name string) ([]fs.DirEntry, error) {
	results := make([]fs.DirEntry, 0)
	seen := make(map[string]struct{})

	for _, fss := range m.fileSystems {
		secondary, err := fs.ReadDir(fss, name)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}

		for _, entry := range secondary {
			name := entry.Name()
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			results = append(results, entry)
		}
	}

	return results, nil
}

func (m *MergedFS) ReadFile(name string) (data []byte, err error) {
	for _, fss := range m.fileSystems {
		data, err = fs.ReadFile(fss, name)
		if err == nil || !errors.Is(err, fs.ErrNotExist) {
			return
		}
	}

	return nil, os.ErrNotExist
}
