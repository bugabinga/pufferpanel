package utils

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOpenat2Probe(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TMPDIR", root)
	previous := useOpenat2
	t.Cleanup(func() { useOpenat2 = previous })

	dir, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	fd, err := unix.Openat2(int(dir.Fd()), ".", &unix.OpenHow{
		Flags:   unix.O_RDONLY,
		Resolve: unix.RESOLVE_BENEATH,
	})
	if err == nil {
		_ = unix.Close(fd)
	} else if !errors.Is(err, unix.ENOSYS) && !errors.Is(err, unix.EOPNOTSUPP) {
		t.Fatal(err)
	}
	want := err == nil

	useOpenat2 = !want
	if got := testOpenat2(); got != want {
		t.Fatalf("testOpenat2() = %v, syscall support = %v", got, want)
	}
	if UseOpenat2() != want {
		t.Fatalf("UseOpenat2() = %v, want %v", UseOpenat2(), want)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("probe left temporary files: %v", entries)
	}
}

func TestOpenat2ProbeTempError(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	previous := useOpenat2
	t.Cleanup(func() { useOpenat2 = previous })
	defer func() {
		recovered := recover()
		err, ok := recovered.(error)
		if !ok || !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("expected missing-temp-directory error, got %v", recovered)
		}
	}()
	testOpenat2()
}
