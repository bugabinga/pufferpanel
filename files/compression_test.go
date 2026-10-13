package files

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mholt/archives"
	"github.com/nwaples/rardecode/v2"
	"github.com/ulikunitz/xz/lzma"
)

func TestExtractZipFilterSkipRootAndModes(t *testing.T) {
	root := t.TempDir()
	source, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = source.Close() })
	archive := filepath.Join(root, "input.zip")
	writeZip(t, archive, map[string]string{"root/keep.txt": "keep", "root/nested/drop.txt": "drop"})
	if err := Extract(source, "input.zip", source, "output", "keep.txt", true, nil); err != nil {
		t.Fatal(err)
	}
	contents, err := source.ReadFile("output/keep.txt")
	if err != nil || string(contents) != "keep" {
		t.Fatalf("keep = %q, %v", contents, err)
	}
	if _, err := source.Lstat("output/nested/drop.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("filtered file error = %v", err)
	}
	info, err := source.Lstat("output/keep.txt")
	if err != nil || info.Mode().Perm() != 0644 {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
}

func TestExtractTarAndTarGz(t *testing.T) {
	for _, suffix := range []string{".tar", ".tar.gz"} {
		t.Run(suffix, func(t *testing.T) {
			root := t.TempDir()
			server, err := NewFileServer(root, -1, -1, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			writeTar(t, filepath.Join(root, "input"+suffix), suffix == ".tar.gz", "folder/file", "content")
			if err := Extract(server, "input"+suffix, server, "out", "*", false, nil); err != nil {
				t.Fatal(err)
			}
			contents, err := server.ReadFile("out/folder/file")
			if err != nil || string(contents) != "content" {
				t.Fatalf("contents = %q, %v", contents, err)
			}
		})
	}
}

func TestExtractRejectsUnsafeArchivePathsBeforeWriting(t *testing.T) {
	for _, name := range []string{"../sentinel", "/sentinel", `dir\\escape`, `C:drive`, "root/../sentinel"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			server, err := NewFileServer(root, -1, -1, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			writeZip(t, filepath.Join(root, "input.zip"), map[string]string{name: "bad"})
			if err := Extract(server, "input.zip", server, "out", "*", false, nil); err == nil {
				t.Fatal("expected invalid archive path")
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(root), "sentinel")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("escape sentinel = %v", err)
			}
		})
	}
}

func TestArchivePathRejectsParentsBeforeNormalization(t *testing.T) {
	for _, name := range []string{"root/../file", "../file", "root/../../file"} {
		if _, err := archivePath(name); err == nil {
			t.Errorf("archivePath(%q) accepted parent segment", name)
		}
	}
	for _, name := range []string{"./", "folder/", "./folder/file"} {
		if _, err := archivePath(name); err != nil {
			t.Errorf("archivePath(%q): %v", name, err)
		}
	}
}

func TestTargetArchivePathUsesFileServerRules(t *testing.T) {
	for _, target := range []string{"../target", "nested/../../target"} {
		if _, err := targetArchivePath(target, "file"); !errors.Is(err, ErrInvalidAccess) {
			t.Errorf("targetArchivePath(%q) = %v, want ErrInvalidAccess", target, err)
		}
	}
	for _, target := range []string{"/target", "/../target", "/"} {
		if _, err := targetArchivePath(target, "file"); err != nil {
			t.Errorf("targetArchivePath(%q): %v", target, err)
		}
	}
}

func TestExtractDoesNotFollowExistingSymlinkParent(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "out"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "out", "link")); err != nil {
		t.Fatal(err)
	}
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	writeZip(t, filepath.Join(root, "input.zip"), map[string]string{"link/file": "bad"})
	if err := Extract(server, "input.zip", server, "out", "*", false, nil); err == nil {
		t.Fatal("expected symlink parent rejection")
	}
	if _, err := os.Stat(filepath.Join(external, "file")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("external file = %v", err)
	}
}

func TestExtractSkipsLinks(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	file, err := os.Create(filepath.Join(root, "input.tar"))
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	for _, header := range []tar.Header{
		{Name: "symlink", Typeflag: tar.TypeSymlink, Linkname: "/outside"},
		{Name: "hardlink", Typeflag: tar.TypeLink, Linkname: "/outside"},
	} {
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Extract(server, "input.tar", server, "out", "*", false, nil); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"symlink", "hardlink"} {
		if _, err := server.Lstat("out/" + name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s = %v, want not exist", name, err)
		}
	}
}

func TestExtractLimitsMetadataBeforeOpeningOutput(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.WriteFile("input.data", []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	walker := fakeExtractor{entries: []archives.FileInfo{fakeArchiveFile("large", maxExtractedFileSize+1, failingFile{Reader: strings.NewReader("")})}}
	if err := Extract(server, "input.data", server, "out", "*", false, walker); !errors.Is(err, ErrArchiveLimit) {
		t.Fatalf("Extract = %v, want ErrArchiveLimit", err)
	}
	if _, err := server.Lstat("out/large"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("output = %v", err)
	}
}

func TestExtractPropagatesReaderAndCloseErrors(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.WriteFile("input.data", []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, open := range []func() fs.File{
		func() fs.File {
			return failingFile{Reader: strings.NewReader("partial"), err: errors.New("read failure")}
		},
		func() fs.File {
			return failingFile{Reader: strings.NewReader("partial"), closeErr: errors.New("close failure")}
		},
	} {
		walker := fakeExtractor{entries: []archives.FileInfo{fakeArchiveFile("file", -1, open())}}
		if err := Extract(server, "input.data", server, "out", "*", false, walker); err == nil {
			t.Fatal("expected extraction error")
		}
	}
}

func TestContextReaderStopsCancelledCopy(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := contextReader{Context: ctx, Reader: strings.NewReader("data")}.Read(make([]byte, 4))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Read = %v", err)
	}
}

func TestExtractArchiveFixtures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		fixtures []string
		archive  string
		contents map[string]string
	}{
		{
			name:     "7z",
			fixtures: []string{"valid.7z"},
			archive:  "valid.7z",
			contents: map[string]string{"bar": "bar\n", "foo": "foo\n"},
		},
		{
			name:     "rar5",
			fixtures: []string{"valid-rar5.rar"},
			archive:  "valid-rar5.rar",
			contents: map[string]string{"testdata/proverbs/proverb1.txt": ""},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			server, err := NewFileServer(root, -1, -1, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			for _, fixture := range tc.fixtures {
				data, err := os.ReadFile(filepath.Join("testdata", fixture))
				if err != nil {
					t.Fatal(err)
				}
				if err := server.WriteFile(fixture, data, 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err := Extract(server, tc.archive, server, "nested/output", "*", false, nil); err != nil {
				t.Fatal(err)
			}
			for name, want := range tc.contents {
				data, err := server.ReadFile(filepath.Join("nested/output", name))
				if err != nil {
					t.Fatal(err)
				}
				if want != "" && string(data) != want {
					t.Fatalf("%s = %q, want %q", name, data, want)
				}
				if name == "testdata/proverbs/proverb1.txt" && fmt.Sprintf("%x", sha256.Sum256(data)) != "4eebbcf9d1657727305314903fbae7c091892a4c96aae836fe3a47c0e4314628" {
					t.Fatal("unexpected RAR content")
				}
			}
			if _, err := server.Lstat("testdata/proverbs/proverb1.txt"); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("archive wrote outside target: %v", err)
			}
		})
	}
}

func TestExtractForcedRar(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "valid-rar5.rar"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		extractor archives.Extractor
	}{
		{name: "value", extractor: archives.Rar{}},
		{name: "pointer", extractor: &archives.Rar{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			server, err := NewFileServer(root, -1, -1, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			if err := server.WriteFile("input.rar", data, 0644); err != nil {
				t.Fatal(err)
			}
			if err := Extract(server, "input.rar", server, "out", "*", false, tc.extractor); err != nil {
				t.Fatal(err)
			}
			if _, err := server.Lstat("out/testdata/proverbs/proverb1.txt"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestExtractRejectsRarDictionaryBeforeAllocation(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "dictionary-512m.rar"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		extractor archives.Extractor
	}{
		{name: "automatic"},
		{name: "value", extractor: archives.Rar{}},
		{name: "pointer", extractor: &archives.Rar{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			server, err := NewFileServer(root, -1, -1, false)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.Close() })
			if err := server.WriteFile("dictionary-512m.rar", data, 0644); err != nil {
				t.Fatal(err)
			}
			runtime.GC()
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			start := time.Now()
			err = Extract(server, "dictionary-512m.rar", server, "out", "*", false, tc.extractor)
			if !errors.Is(err, rardecode.ErrDictionaryTooLarge) {
				t.Fatalf("Extract = %v, want dictionary limit error", err)
			}
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Fatalf("dictionary limit took %v", elapsed)
			}
			runtime.GC()
			runtime.ReadMemStats(&after)
			if after.HeapAlloc > before.HeapAlloc+16<<20 {
				t.Fatalf("dictionary limit retained %d bytes", after.HeapAlloc-before.HeapAlloc)
			}
			if _, err := server.Lstat("out/testdata/proverbs/proverb1.txt"); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("output = %v", err)
			}
		})
	}
}

func TestNewRarExtractorOptions(t *testing.T) {
	extractor, err := newRarExtractor(archives.Rar{Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if extractor.password != "secret" {
		t.Fatalf("password = %q", extractor.password)
	}
	for _, tc := range []struct {
		name   string
		format archives.Rar
		want   string
	}{
		{name: "continue on error", format: archives.Rar{ContinueOnError: true}, want: "ContinueOnError"},
		{name: "name", format: archives.Rar{Name: "archive.part1.rar"}, want: "Name"},
		{name: "file system", format: archives.Rar{FS: os.DirFS(t.TempDir())}, want: "FS"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := newRarExtractor(tc.format)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("newRarExtractor = %v, want unsupported %s error", err, tc.want)
			}
		})
	}
}

func TestExtractPreservesLegacyArchiveFilterNames(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	writeZip(t, filepath.Join(root, "input.zip"), map[string]string{"root/nested/keep.txt": "keep"})
	if err := Extract(server, "input.zip", server, "zip-out", "keep.txt", false, nil); err != nil {
		t.Fatal(err)
	}
	if data, err := server.ReadFile("zip-out/root/nested/keep.txt"); err != nil || string(data) != "keep" {
		t.Fatalf("ZIP nested basename filter = %q, %v", data, err)
	}

	if err := server.WriteFile("input.data", []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	header := &rardecode.FileHeader{Name: "root/nested/keep.txt"}
	walker := fakeExtractor{entries: []archives.FileInfo{{
		FileInfo:      rarFileInfo{header: header},
		Header:        header,
		NameInArchive: header.Name,
		Open: func() (fs.File, error) {
			t.Fatal("RAR entry must be filtered before opening")
			return nil, nil
		},
	}}}
	if err := Extract(server, "input.data", server, "rar-out", "keep.txt", false, walker); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Lstat("rar-out/root/nested/keep.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("RAR nested full path matched basename: %v", err)
	}
}

func TestExtractFormatAliasesAndCompressionOnlyInput(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	writeZip(t, filepath.Join(root, "input.zipx"), map[string]string{"file.txt": "zipx"})
	if err := Extract(server, "input.zipx", server, "zipx-out", "*", false, nil); err != nil {
		t.Fatalf("ZIP payload with .zipx extension = %v", err)
	}
	if data, err := server.ReadFile("zipx-out/file.txt"); err != nil || string(data) != "zipx" {
		t.Fatalf("ZIPX content = %q, %v", data, err)
	}

	var compressed bytes.Buffer
	writer, err := lzma.NewWriter(&compressed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("lzma")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader, err := lzma.NewReader(bytes.NewReader(compressed.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if data, err := io.ReadAll(reader); err != nil || string(data) != "lzma" {
		t.Fatalf("LZMA control = %q, %v", data, err)
	}
	if err := server.WriteFile("input.lzma", compressed.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Extract(server, "input.lzma", server, "lzma-out", "*", false, nil); err == nil {
		t.Fatal("compression-only LZMA input was accepted as an archive")
	}
	if _, err := server.Lstat("lzma-out"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("LZMA output = %v", err)
	}
}

func TestCompressRootRoundTripsWithPrefixName(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.MkdirAll("nested", 0755); err != nil {
		t.Fatal(err)
	}
	if err := server.WriteFile("nested/file", []byte("content"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := Compress(server, server, "archive.tar.gz", []string{"."}); err != nil {
		t.Fatal(err)
	}
	if err := Extract(server, "archive.tar.gz", server, "restored", "*", true, nil); err != nil {
		t.Fatal(err)
	}
	data, err := server.ReadFile("restored/nested/file")
	if err != nil || string(data) != "content" {
		t.Fatalf("root round trip = %q, %v", data, err)
	}
	info, err := server.Lstat("restored/nested/file")
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("root round trip mode = %v, %v", info.Mode(), err)
	}
}

func TestCompressDoesNotMutateInputAndRoundTrips(t *testing.T) {
	root := t.TempDir()
	server, err := NewFileServer(root, -1, -1, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	if err := server.MkdirAll("source/nested", 0755); err != nil {
		t.Fatal(err)
	}
	if err := server.WriteFile("source/nested/file", []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}
	input := []string{"source"}
	if err := Compress(server, server, "archive.zip", input); err != nil {
		t.Fatal(err)
	}
	if input[0] != "source" {
		t.Fatalf("input mutated: %q", input[0])
	}
	if err := Extract(server, "archive.zip", server, "out", "*", false, nil); err != nil {
		t.Fatal(err)
	}
	contents, err := server.ReadFile("out/source/nested/file")
	if err != nil || string(contents) != "content" {
		t.Fatalf("round trip = %q, %v", contents, err)
	}
}

type fakeExtractor struct {
	entries []archives.FileInfo
}

func (extractor fakeExtractor) Extract(ctx context.Context, _ io.Reader, handle archives.FileHandler) error {
	for _, entry := range extractor.entries {
		if err := handle(ctx, entry); err != nil {
			return err
		}
	}
	return nil
}

type fakeFileInfo struct {
	name string
	size int64
	mode os.FileMode
}

func (info fakeFileInfo) Name() string       { return info.name }
func (info fakeFileInfo) Size() int64        { return info.size }
func (info fakeFileInfo) Mode() os.FileMode  { return info.mode }
func (info fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (info fakeFileInfo) IsDir() bool        { return info.mode.IsDir() }
func (info fakeFileInfo) Sys() any           { return nil }

func fakeArchiveFile(name string, size int64, file fs.File) archives.FileInfo {
	return archives.FileInfo{
		FileInfo:      fakeFileInfo{name: filepath.Base(name), size: size, mode: 0644},
		NameInArchive: name,
		Open:          func() (fs.File, error) { return file, nil },
	}
}

type failingFile struct {
	io.Reader
	err      error
	closeErr error
}

func (file failingFile) Stat() (fs.FileInfo, error) {
	return fakeFileInfo{name: "file", mode: 0644}, nil
}
func (file failingFile) Close() error { return file.closeErr }
func (file failingFile) Read(p []byte) (int, error) {
	if file.err != nil {
		return 0, file.err
	}
	return file.Reader.Read(p)
}

func writeZip(t *testing.T, filename string, files map[string]string) {
	t.Helper()
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, content := range files {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeTar(t *testing.T, filename string, compressed bool, name, content string) {
	t.Helper()
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	var output io.Writer = file
	var gzipWriter *gzip.Writer
	if compressed {
		gzipWriter = gzip.NewWriter(file)
		output = gzipWriter
	}
	writer := tar.NewWriter(output)
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if gzipWriter != nil {
		if err := gzipWriter.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
