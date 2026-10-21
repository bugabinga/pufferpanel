package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileServerRejectsRootEscapes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root")
	outside := filepath.Join(parent, "sentinel")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("sentinel"), 0644); err != nil {
		t.Fatal(err)
	}
	//os.WriteFile is subject to the process umask, so pin the fixture mode explicitly
	if err := os.Chmod(outside, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Fatal(err)
	}

	server, err := NewFileServer(root, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	if _, err := server.Open("../sentinel"); err == nil {
		t.Error("Open allowed traversal outside root")
	}
	if _, err := server.Lstat("../sentinel"); err == nil {
		t.Error("Lstat allowed traversal outside root")
	}
	if err := server.Chmod("../sentinel", 0600); err == nil {
		t.Error("Chmod allowed traversal outside root")
	}
	if err := server.Chmod("outside", 0600); err == nil {
		t.Error("Chmod followed symlink outside root")
	}
	info, err := os.Stat(outside)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Errorf("outside mode = %04o, want 0644", info.Mode().Perm())
	}
	if _, err := server.CreateTemp("..", "temp-*"); err == nil {
		t.Error("CreateTemp allowed traversal outside root")
	}

	if err := server.WriteFile("/inside", []byte("inside"), 0644); err != nil {
		t.Fatalf("WriteFile with root-relative path: %v", err)
	}
	if _, err := server.Lstat("/inside"); err != nil {
		t.Fatalf("Lstat with root-relative path: %v", err)
	}
}

func TestFileServerRootOperationsUseAnchor(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root")
	moved := filepath.Join(parent, "moved")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}

	server, err := NewFileServer(root, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	rootFile, err := server.OpenFile("", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("OpenFile root: %v", err)
	}
	if err := rootFile.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Lstat(""); err != nil {
		t.Fatalf("Lstat root: %v", err)
	}
	if err := server.Chmod("", 0700); err != nil {
		t.Fatalf("Chmod root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "write-only"), []byte("x"), 0200); err != nil {
		t.Fatal(err)
	}
	if err := server.Chmod("write-only", 0600); err != nil {
		t.Fatalf("Chmod write-only file: %v", err)
	}
	info, err := os.Stat(filepath.Join(root, "write-only"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("write-only file mode = %04o, want 0600", info.Mode().Perm())
	}

	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := server.WriteFile("anchored", []byte("anchored"), 0600); err != nil {
		t.Fatalf("WriteFile after root move: %v", err)
	}
	if content, err := os.ReadFile(filepath.Join(moved, "anchored")); err != nil || string(content) != "anchored" {
		t.Fatalf("anchored file = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(root, "anchored")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement root file error = %v, want not exist", err)
	}
}

func TestFileServerCreateTempReturnsRootRelativeName(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	if err := server.MkdirAll("cache/nested", 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := server.CreateTemp("cache/nested", "invalid/name"); !errors.Is(err, fs.ErrInvalid) {
		t.Fatalf("CreateTemp pattern error = %v, want fs.ErrInvalid", err)
	}
	temporary, err := server.CreateTemp("cache/nested", "tmp-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.IsAbs(temporary.Name()) || filepath.Dir(temporary.Name()) != "cache/nested" || !strings.HasSuffix(temporary.Name(), ".zip") {
		t.Fatalf("CreateTemp name = %q, want root-relative nested cache path with suffix", temporary.Name())
	}
	info, err := temporary.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("CreateTemp mode = %04o, want 0600", info.Mode().Perm())
	}
	second, err := server.CreateTemp("cache/nested", "tmp-*.zip")
	if err != nil {
		t.Fatal(err)
	}
	if second.Name() == temporary.Name() {
		t.Fatalf("CreateTemp reused name %q", temporary.Name())
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := server.Remove(second.Name()); err != nil {
		t.Fatal(err)
	}
	if _, err := temporary.WriteString("data"); err != nil {
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	if err := server.Rename(temporary.Name(), "cache/nested/download.zip"); err != nil {
		t.Fatalf("Rename temporary file: %v", err)
	}
	if content, err := server.ReadFile("cache/nested/download.zip"); err != nil || string(content) != "data" {
		t.Fatalf("ReadFile after Rename = %q, %v", content, err)
	}
}

func TestFileServerRemoveUnlinksSymlinkWithoutFollowing(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(outside, []byte("safe"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.Remove("link"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "link")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("link = %v, want not exist", err)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "safe" {
		t.Fatalf("outside = %q, %v", data, err)
	}
}

func TestFileServerSymlinkIsUnsupported(t *testing.T) {
	server, err := NewFileServer(t.TempDir(), 0, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	for _, paths := range [][2]string{
		{"testfile", "../escape"},
		{"internal/testfile", "../escape"},
		{"testfile", "/escape"},
		{"../../../../../../outside/file", "file"},
	} {
		t.Run(paths[0]+"->"+paths[1], func(t *testing.T) {
			if err := server.Symlink(paths[0], paths[1]); !errors.Is(err, ErrSymlinkNotSupported) {
				t.Fatalf("Symlink() error = %v, want %v", err, ErrSymlinkNotSupported)
			}
		})
	}
}
