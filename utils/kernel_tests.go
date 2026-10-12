package utils

import (
	"errors"
	"fmt"
	"os"

	"github.com/pufferpanel/pufferpanel/v3/sys"
	"golang.org/x/sys/unix"
)

func testOpenat2() bool {
	testPath, err := os.MkdirTemp(os.TempDir(), "puffer-openat2-test-*")
	if err != nil {
		panic(fmt.Errorf("failed to validate kernel support with test file\n%w", err))
	}
	defer os.RemoveAll(testPath)

	testFile, err := os.Open(testPath)
	if err != nil {
		panic(fmt.Errorf("failed to validate kernel support with test file\n%w", err))
	}
	defer Close(testFile)

	fd, err := unix.Openat2(int(testFile.Fd()), "validate", &unix.OpenHow{
		Flags:   uint64(os.O_CREATE),
		Mode:    uint64(sys.SyscallMode(0644)),
		Resolve: unix.RESOLVE_BENEATH,
	})
	if err == nil {
		_ = unix.Close(fd)
		useOpenat2 = true
	} else if errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.ENOSYS) {
		useOpenat2 = false
	} else {
		panic(fmt.Errorf("failed to validate kernel support with test file\n%w", err))
	}
	return useOpenat2
}
