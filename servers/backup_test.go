package servers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pufferpanel/pufferpanel/v3"
	"github.com/pufferpanel/pufferpanel/v3/files"
)

type idleEnvironment struct {
	err error
}

func (environment idleEnvironment) ExecuteAsyncImpl(*pufferpanel.Environment, pufferpanel.ExecutionData) error {
	return nil
}
func (environment idleEnvironment) KillImpl(*pufferpanel.Environment) error { return nil }
func (environment idleEnvironment) GetStatsImpl(*pufferpanel.Environment) (*pufferpanel.ServerStats, error) {
	return nil, nil
}
func (environment idleEnvironment) SendCodeImpl(*pufferpanel.Environment, int) error { return nil }
func (environment idleEnvironment) GetUidImpl(*pufferpanel.Environment) int          { return -1 }
func (environment idleEnvironment) GetGidImpl(*pufferpanel.Environment) int          { return -1 }
func (environment idleEnvironment) IsRunningImpl(*pufferpanel.Environment) (bool, error) {
	return false, environment.err
}

func newBackupTestServer(t *testing.T) (*Server, files.FileServer, files.FileServer) {
	t.Helper()
	live, err := files.NewFileServer(t.TempDir(), -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	backups, err := files.NewFileServer(t.TempDir(), -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	server := CreateProgram()
	server.Identifier = "backup-test"
	server.fileServer = live
	server.backupServer = backups
	server.RunningEnvironment = &pufferpanel.Environment{
		ConsoleBuffer:  pufferpanel.CreateCache(),
		ConsoleTracker: pufferpanel.CreateTracker(),
		Implementation: idleEnvironment{},
		Wait:           &sync.Mutex{},
	}
	t.Cleanup(func() { _ = live.Close(); _ = backups.Close() })
	return server, live, backups
}

func waitForBackupJob(t *testing.T, server *Server) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for server.IsBackingUp() || server.IsRestoring() {
		if time.Now().After(deadline) {
			t.Fatal("backup job did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestBackupRootRoundTripRestore(t *testing.T) {
	server, live, backups := newBackupTestServer(t)
	if err := live.MkdirAll("nested/bin", 0755); err != nil {
		t.Fatal(err)
	}
	if err := live.WriteFile("nested/bin/run", []byte("original"), 0755); err != nil {
		t.Fatal(err)
	}
	backup, err := server.StartBackup()
	if err != nil {
		t.Fatal(err)
	}
	waitForBackupJob(t, server)
	if err := live.WriteFile("nested/bin/run", []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := server.StartRestore(backup); err != nil {
		t.Fatal(err)
	}
	waitForBackupJob(t, server)
	contents, err := live.ReadFile("nested/bin/run")
	if err != nil || string(contents) != "original" {
		t.Fatalf("restored contents = %q, %v", contents, err)
	}
	info, err := live.Lstat("nested/bin/run")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("restored mode = %v", info.Mode())
	}
	if _, err := backups.Stat(backup); err != nil {
		t.Fatalf("backup retained: %v", err)
	}
}

func TestRestoreMissingBackupRetainsLiveFiles(t *testing.T) {
	server, live, _ := newBackupTestServer(t)
	if err := live.MkdirAll("nested", 0755); err != nil {
		t.Fatal(err)
	}
	if err := live.WriteFile("nested/sentinel", []byte("safe"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := server.StartRestore("missing.tar.gz"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("StartRestore = %v, want not exist", err)
	}
	contents, err := live.ReadFile("nested/sentinel")
	if err != nil || string(contents) != "safe" {
		t.Fatalf("sentinel = %q, %v", contents, err)
	}
	if _, err := server.GetBackup("missing.tar.gz"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("GetBackup = %v, want not exist", err)
	}
}

func TestRestoreMalformedBackupRetainsLiveFiles(t *testing.T) {
	server, live, backups := newBackupTestServer(t)
	if err := live.MkdirAll("nested", 0755); err != nil {
		t.Fatal(err)
	}
	if err := live.WriteFile("nested/sentinel", []byte("safe"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := backups.WriteFile("broken.tar.gz", []byte("not an archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := server.StartRestore("broken.tar.gz"); err != nil {
		t.Fatal(err)
	}
	waitForBackupJob(t, server)
	contents, err := live.ReadFile("nested/sentinel")
	if err != nil || string(contents) != "safe" {
		t.Fatalf("sentinel = %q, %v", contents, err)
	}
	if _, err := backups.Stat("broken.tar.gz"); err != nil {
		t.Fatalf("backup retained: %v", err)
	}
}

func TestIsIdleReturnsStatusError(t *testing.T) {
	server, _, _ := newBackupTestServer(t)
	want := errors.New("status failed")
	server.RunningEnvironment.Implementation = idleEnvironment{err: want}
	if err := server.IsIdle(); !errors.Is(err, want) {
		t.Fatalf("IsIdle = %v, want %v", err, want)
	}
}

func TestRestoreInvalidArchivesRetainLiveFiles(t *testing.T) {
	makeZip := func(names ...string) []byte {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		for _, name := range names {
			header := &zip.FileHeader{Name: name, Method: zip.Store}
			header.SetMode(0755)
			file, err := writer.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.Write([]byte("checksum-protected-payload")); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}
	corrupt := makeZip("root/file")
	position := bytes.Index(corrupt, []byte("checksum-protected-payload"))
	if position < 0 {
		t.Fatal("ZIP payload missing")
	}
	corrupt[position] ^= 1
	var oversized bytes.Buffer
	if err := tar.NewWriter(&oversized).WriteHeader(&tar.Header{Name: "root/large", Mode: 0600, Size: (1 << 30) + 1, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		data []byte
	}{
		{name: "traversal.zip", data: makeZip("root/first", "../escape")},
		{name: "checksum.zip", data: corrupt},
		{name: "oversized.tar", data: oversized.Bytes()},
	} {
		t.Run(test.name, func(t *testing.T) {
			server, live, backups := newBackupTestServer(t)
			if err := live.MkdirAll("nested", 0700); err != nil {
				t.Fatal(err)
			}
			if err := live.WriteFile("nested/sentinel", []byte("unchanged"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := backups.WriteFile(test.name, test.data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := server.StartRestore(test.name); err != nil {
				t.Fatal(err)
			}
			waitForBackupJob(t, server)
			contents, err := live.ReadFile("nested/sentinel")
			if err != nil || string(contents) != "unchanged" {
				t.Fatalf("live data = %q, %v", contents, err)
			}
			info, err := live.Lstat("nested/sentinel")
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0755 {
				t.Fatalf("live mode = %v", info.Mode())
			}
			archive, err := backups.ReadFile(test.name)
			if err != nil || !bytes.Equal(archive, test.data) {
				t.Fatalf("backup changed: %v", err)
			}
			console, _ := server.RunningEnvironment.ConsoleBuffer.Read()
			if !strings.Contains(string(console), "Restore failed") || strings.Contains(string(console), "Restore complete") {
				t.Fatalf("incorrect completion result: %s", console)
			}
		})
	}
}

func TestBackupFailureReportsFailure(t *testing.T) {
	server, _, backups := newBackupTestServer(t)
	if err := backups.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := server.StartBackup(); err != nil {
		t.Fatal(err)
	}
	waitForBackupJob(t, server)
	console, _ := server.RunningEnvironment.ConsoleBuffer.Read()
	if !strings.Contains(string(console), "Backup failed") || strings.Contains(string(console), "Backup complete") {
		t.Fatalf("incorrect completion result: %s", console)
	}
}

func TestBackupRestoreClaimsAreExclusive(t *testing.T) {
	server, _, _ := newBackupTestServer(t)
	var workers sync.WaitGroup
	start := make(chan struct{})
	claimed := make(chan bool, 32)
	for i := range 32 {
		workers.Go(func() {
			<-start
			backup := i%2 == 0
			if err := server.claimBackupRestore(backup); err == nil {
				claimed <- backup
			} else if !errors.Is(err, pufferpanel.ErrBackupInProgress) {
				t.Errorf("claim returned unexpected error: %v", err)
			}
		})
	}
	close(start)
	workers.Wait()
	if len(claimed) != 1 {
		t.Fatalf("successful concurrent claims = %d, want 1", len(claimed))
	}
	server.finishBackupRestore(<-claimed, true)
	if server.IsBackingUp() || server.IsRestoring() {
		t.Fatal("busy flag retained after completion")
	}
	if !server.isUnsafeRunning.TryLock() {
		t.Fatal("operation lock retained after completion")
	}
	server.isUnsafeRunning.Unlock()
}

func TestBackupRestoreStatusPolling(t *testing.T) {
	server, _, backups := newBackupTestServer(t)
	if err := backups.WriteFile("exists.tar.gz", []byte("unused"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := server.claimBackupRestore(true); err != nil {
		t.Fatal(err)
	}
	if _, err := server.StartBackup(); !errors.Is(err, pufferpanel.ErrBackupInProgress) {
		t.Fatalf("overlapping backup = %v", err)
	}
	if err := server.StartRestore("exists.tar.gz"); !errors.Is(err, pufferpanel.ErrBackupInProgress) {
		t.Fatalf("overlapping restore = %v", err)
	}
	if err := server.Start(); !errors.Is(err, pufferpanel.ErrBackupInProgress) {
		t.Fatalf("overlapping start = %v", err)
	}
	var workers sync.WaitGroup
	start := make(chan struct{})
	for range 32 {
		workers.Go(func() {
			<-start
			for range 128 {
				_ = server.IsBackingUp()
				_ = server.IsRestoring()
				_ = server.IsIdle()
			}
		})
	}
	close(start)
	server.finishBackupRestore(true, true)
	workers.Wait()
}
