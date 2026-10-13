package servers

import (
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/files"
)

func TestLoadInitializesPerServerBackupFilesystem(t *testing.T) {
	root := t.TempDir()
	serverRoot := filepath.Join(root, "servers")
	backupRoot := filepath.Join(root, "backups")
	if err := os.MkdirAll(filepath.Join(serverRoot, "loader-backup-test"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(backupRoot, 0755); err != nil {
		t.Fatal(err)
	}

	previousServersFolder := config.ServersFolder.Value()
	previousBackupsFolder := config.BackupsFolder.Value()
	if err := config.ServersFolder.Set(serverRoot, false); err != nil {
		t.Fatal(err)
	}
	if err := config.BackupsFolder.Set(backupRoot, false); err != nil {
		t.Fatal(err)
	}
	previousServerFS := files.ServerFS
	previousBackupFS := files.BackupFS
	serverFS, err := files.NewFileServer(serverRoot, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	backupFS, err := files.NewFileServer(backupRoot, 0, 0, false)
	if err != nil {
		_ = serverFS.Close()
		t.Fatal(err)
	}
	files.ServerFS = serverFS
	files.BackupFS = backupFS
	t.Cleanup(func() {
		files.ServerFS = previousServerFS
		files.BackupFS = previousBackupFS
		_ = serverFS.Close()
		_ = backupFS.Close()
		_ = config.ServersFolder.Set(previousServersFolder, false)
		_ = config.BackupsFolder.Set(previousBackupsFolder, false)
	})

	server, err := LoadFromData("loader-backup-test", []byte(`{"type":"test","environment":{"type":"host"}}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		server.Scheduler.Stop()
		_ = server.fileServer.Close()
		_ = server.backupServer.Close()
	})

	if server.GetFileServer() == nil || server.backupServer == nil {
		t.Fatal("LoadFromData must initialize both file servers")
	}
	if got, want := server.backupServer.Prefix(), filepath.Join(files.BackupFS.Prefix(), server.Id()); got != want {
		t.Fatalf("backup prefix = %q, want %q", got, want)
	}
	if err := server.GetFileServer().MkdirAll("nested/bin", 0755); err != nil {
		t.Fatal(err)
	}
	if err := server.GetFileServer().WriteFile("nested/bin/run", []byte("backup contents"), 0751); err != nil {
		t.Fatal(err)
	}

	backupName, err := server.StartBackup()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for server.IsBackingUp() {
		if time.Now().After(deadline) {
			t.Fatal("backup did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	backupData, err := server.GetBackup(backupName)
	if err != nil {
		t.Fatal(err)
	}
	if backupData.Name != backupName {
		t.Fatalf("backup name = %q, want %q", backupData.Name, backupName)
	}
	backupFile, err := server.GetBackupFile(backupName)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := io.ReadAll(backupFile.Contents)
	closeErr := backupFile.Contents.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if int64(len(archive)) != backupFile.ContentLength {
		t.Fatalf("archive length = %d, want %d", len(archive), backupFile.ContentLength)
	}

	if err := server.GetFileServer().WriteFile("nested/bin/run", []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := server.StartRestore(backupName); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for server.IsRestoring() {
		if time.Now().After(deadline) {
			t.Fatal("restore did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	contents, err := server.GetFileServer().ReadFile("nested/bin/run")
	if err != nil || string(contents) != "backup contents" {
		t.Fatalf("restored contents = %q, %v", contents, err)
	}
	info, err := server.GetFileServer().Lstat("nested/bin/run")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0751 {
		t.Fatalf("restored mode = %v, want 0751", info.Mode().Perm())
	}
}
