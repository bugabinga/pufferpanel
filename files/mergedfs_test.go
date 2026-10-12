package files

import (
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
