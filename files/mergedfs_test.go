package files

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"slices"
	"testing"
	"testing/fstest"
)

func TestMergedFSReadDir(t *testing.T) {
	tests := []struct {
		name    string
		systems []fs.FS
		path    string
		want    []string
	}{
		{name: "empty", path: ".", want: []string{}},
		{
			name: "precedence and order",
			systems: []fs.FS{
				fstest.MapFS{"b": &fstest.MapFile{}, "shared": &fstest.MapFile{Data: []byte("first")}},
				fstest.MapFS{"a": &fstest.MapFile{}, "shared": &fstest.MapFile{Mode: fs.ModeDir}},
			},
			path: ".",
			want: []string{"b", "shared", "a"},
		},
		{
			name:    "missing directory",
			systems: []fs.FS{fstest.MapFS{}},
			path:    "missing",
			want:    []string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entries, err := NewMergedFS(tt.systems...).ReadDir(tt.path)
			if err != nil {
				t.Fatal(err)
			}
			if entries == nil {
				t.Fatal("ReadDir returned nil entries")
			}
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				names = append(names, entry.Name())
				if entry.Name() == "shared" && entry.IsDir() {
					t.Fatal("later filesystem replaced first entry")
				}
			}
			if !slices.Equal(names, tt.want) {
				t.Fatalf("ReadDir names = %v, want %v", names, tt.want)
			}
		})
	}
}

func TestMergedFSReadDirError(t *testing.T) {
	_, err := NewMergedFS(fstest.MapFS{"file": &fstest.MapFile{}}).ReadDir("file")
	if err == nil {
		t.Fatal("ReadDir accepted regular file as directory")
	}
}

type openOnlyFS struct {
	files  map[string]*openOnlyFile
	errors map[string]error
	opens  map[string]int
}

func (f *openOnlyFS) Open(name string) (fs.File, error) {
	if f.opens != nil {
		f.opens[name]++
	}
	if err := f.errors[name]; err != nil {
		return nil, err
	}
	file := f.files[name]
	if file == nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return file, nil
}

type openOnlyFile struct {
	fs.File
	reader  io.Reader
	entries []fs.DirEntry
	closed  bool
}

func (f *openOnlyFile) Read(p []byte) (int, error) {
	if f.reader != nil {
		return f.reader.Read(p)
	}
	return f.File.Read(p)
}

func (f *openOnlyFile) ReadDir(n int) ([]fs.DirEntry, error) {
	return f.entries, nil
}

func (f *openOnlyFile) Close() error {
	f.closed = true
	return f.File.Close()
}

func newOpenOnlyFile(name string, data []byte, entries ...fs.DirEntry) *openOnlyFile {
	base, _ := (fstest.MapFS{name: &fstest.MapFile{Data: data}}).Open(name)
	return &openOnlyFile{File: base, entries: entries}
}

func TestMergedFSOpenOnlyReadDir(t *testing.T) {
	entryA, _ := (fstest.MapFS{"a": &fstest.MapFile{}}).ReadDir(".")
	entryB, _ := (fstest.MapFS{"b": &fstest.MapFile{}}).ReadDir(".")
	first := newOpenOnlyFile(".", nil, entryB...)
	second := newOpenOnlyFile(".", nil, entryA...)
	got, err := NewMergedFS(&openOnlyFS{files: map[string]*openOnlyFile{".": first}}, &openOnlyFS{files: map[string]*openOnlyFile{".": second}}).ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(got))
	for i, entry := range got {
		names[i] = entry.Name()
	}
	if !slices.Equal(names, []string{"b", "a"}) {
		t.Fatalf("ReadDir names = %v, want [b a]", names)
	}
	if !first.closed || !second.closed {
		t.Fatalf("directory handles closed = %v, %v; want true", first.closed, second.closed)
	}
}

func TestMergedFSReadDirNonMissingErrorStopsFallback(t *testing.T) {
	failure := errors.New("read directory failed")
	later := &openOnlyFS{files: map[string]*openOnlyFile{".": newOpenOnlyFile(".", nil)}}
	_, err := NewMergedFS(&openOnlyFS{errors: map[string]error{".": failure}}, later).ReadDir(".")
	if !errors.Is(err, failure) || later.opens["."] != 0 {
		t.Fatalf("ReadDir error = %v; later opens = %d; want read directory failed, 0", err, later.opens["."])
	}
}

func TestMergedFSOpenOnlyReadFile(t *testing.T) {
	file := newOpenOnlyFile("file", []byte("complete"))
	file.reader = &oneByteReader{data: "complete"}
	later := &openOnlyFS{files: map[string]*openOnlyFile{"file": newOpenOnlyFile("file", []byte("later"))}}
	got, err := NewMergedFS(&openOnlyFS{files: map[string]*openOnlyFile{"file": file}}, later).ReadFile("file")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "complete" {
		t.Fatalf("ReadFile = %q, want complete", got)
	}
	if !file.closed || later.opens["file"] != 0 {
		t.Fatalf("first closed = %v, later opens = %d; want true, 0", file.closed, later.opens["file"])
	}
}

type oneByteReader struct{ data string }

func (r *oneByteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	p[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}

func TestMergedFSReadFileMissingAndErrors(t *testing.T) {
	t.Run("missing all", func(t *testing.T) {
		got, err := NewMergedFS(&openOnlyFS{}, &openOnlyFS{}).ReadFile("missing")
		if !errors.Is(err, fs.ErrNotExist) || got != nil {
			t.Fatalf("ReadFile = %q, %v; want nil, fs.ErrNotExist", got, err)
		}
	})
	t.Run("non-missing stops fallback", func(t *testing.T) {
		failure := errors.New("read failed")
		later := &openOnlyFS{files: map[string]*openOnlyFile{"file": newOpenOnlyFile("file", []byte("later"))}}
		got, err := NewMergedFS(&openOnlyFS{errors: map[string]error{"file": failure}}, later).ReadFile("file")
		if !errors.Is(err, failure) || got != nil || later.opens["file"] != 0 {
			t.Fatalf("ReadFile = %q, %v; later opens = %d; want nil, read failed, 0", got, err, later.opens["file"])
		}
	})
	t.Run("read failure closes and stops fallback", func(t *testing.T) {
		failure := errors.New("read failed")
		file := newOpenOnlyFile("file", nil)
		file.reader = errorReader{err: failure}
		later := &openOnlyFS{files: map[string]*openOnlyFile{"file": newOpenOnlyFile("file", []byte("later"))}}
		got, err := NewMergedFS(&openOnlyFS{files: map[string]*openOnlyFile{"file": file}}, later).ReadFile("file")
		if !errors.Is(err, failure) || len(got) != 0 || !file.closed || later.opens["file"] != 0 {
			t.Fatalf("ReadFile = %q, %v; closed = %v; later opens = %d; want nil, read failed, true, 0", got, err, file.closed, later.opens["file"])
		}
	})
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

func BenchmarkMergedFSReadDir(b *testing.B) {
	for _, size := range []int{16, 1024} {
		for _, duplicateHeavy := range []bool{true, false} {
			name := "unique"
			if duplicateHeavy {
				name = "duplicate-heavy"
			}
			b.Run(fmt.Sprintf("%s/%d", name, size), func(b *testing.B) {
				systems := benchmarkMergedFSListings(size, duplicateHeavy)
				merged := NewMergedFS(systems...)
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					if _, err := merged.ReadDir("."); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}

func benchmarkMergedFSListings(size int, duplicateHeavy bool) []fs.FS {
	const layers = 4
	systems := make([]fs.FS, layers)
	for layer := range layers {
		listing := make(fstest.MapFS, size)
		for i := range size {
			index := layer*size + i
			if duplicateHeavy {
				index %= size / layers
			}
			listing[fmt.Sprintf("file-%06d", index)] = &fstest.MapFile{}
		}
		systems[layer] = listing
	}
	return systems
}
