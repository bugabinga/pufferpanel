package web

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/pufferpanel/pufferpanel/v3/client/frontend/dist"
	"github.com/pufferpanel/pufferpanel/v3/config"
)

func TestServiceWorkerRoute(t *testing.T) {
	originalPanelEnabled := config.PanelEnabled.Value()
	originalDaemonEnabled := config.DaemonEnabled.Value()
	originalWebRoot := config.WebRoot.Value()
	originalClientFiles := clientFiles
	t.Cleanup(func() {
		_ = config.PanelEnabled.Set(originalPanelEnabled, false)
		_ = config.DaemonEnabled.Set(originalDaemonEnabled, false)
		_ = config.WebRoot.Set(originalWebRoot, false)
		clientFiles = originalClientFiles
	})

	_ = config.PanelEnabled.Set(true, false)
	_ = config.DaemonEnabled.Set(false, false)
	_ = config.WebRoot.Set("", false)

	serviceWorker, err := fs.ReadFile(dist.ClientFiles, "sw.js")
	if err != nil {
		t.Fatal(err)
	}
	index, err := fs.ReadFile(dist.ClientFiles, "index.html")
	if err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	RegisterRoutes(router)

	response := serveRequest(router, http.MethodGet, "/sw.js")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /sw.js status = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/javascript") {
		t.Fatalf("GET /sw.js Content-Type = %q, want JavaScript", contentType)
	}
	if !bytes.Equal(response.Body.Bytes(), serviceWorker) {
		t.Fatal("GET /sw.js body does not match embedded service worker")
	}

	response = serveRequest(router, http.MethodHead, "/sw.js")
	if response.Code != http.StatusOK {
		t.Fatalf("HEAD /sw.js status = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/javascript") {
		t.Fatalf("HEAD /sw.js Content-Type = %q, want JavaScript", contentType)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("HEAD /sw.js body length = %d, want 0", response.Body.Len())
	}

	response = serveRequest(router, http.MethodGet, "/missing.js")
	if response.Code != http.StatusNotFound {
		t.Fatalf("GET /missing.js status = %d, want %d", response.Code, http.StatusNotFound)
	}

	response = serveRequest(router, http.MethodGet, "/servers/example")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /servers/example status = %d, want %d", response.Code, http.StatusOK)
	}
	if !bytes.Equal(response.Body.Bytes(), index) {
		t.Fatal("GET /servers/example body does not match embedded SPA index")
	}

	webRoot := t.TempDir()
	customServiceWorker := []byte("self.skipWaiting()")
	if err := os.WriteFile(filepath.Join(webRoot, "sw.js"), customServiceWorker, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "secret.js"), []byte("not public"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = config.WebRoot.Set(webRoot, false)

	router = gin.New()
	RegisterRoutes(router)

	response = serveRequest(router, http.MethodGet, "/sw.js")
	if !bytes.Equal(response.Body.Bytes(), customServiceWorker) {
		t.Fatal("GET /sw.js did not use custom web root service worker")
	}

	response = serveRequest(router, http.MethodGet, "/secret.js")
	if response.Code != http.StatusNotFound {
		t.Fatalf("GET /secret.js status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if bytes.Equal(response.Body.Bytes(), []byte("not public")) {
		t.Fatal("GET /secret.js exposed an unregistered custom web root file")
	}
}

func serveRequest(router http.Handler, method string, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
