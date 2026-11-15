package steamgamedl

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

func Test_getLatestVersion(t *testing.T) {
	goos := strings.ToLower(runtime.GOOS)
	armUrl := "https://example.com/dd/" + goos + "-arm64"
	x64Url := "https://example.com/dd/" + goos + "-x64"
	releases := fmt.Sprintf(`[{"assets":[
		{"name":"DepotDownloader_otheros_x64.zip","browser_download_url":"https://example.com/dd/otheros-x64"},
		{"name":"DepotDownloader_%s_arm64.zip","browser_download_url":"%s"},
		{"name":"DepotDownloader_%s_x64.zip","browser_download_url":"%s"}
	]}]`, goos, armUrl, goos, x64Url)

	t.Run("resolved dd versions", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(releases))
		}))
		defer server.Close()

		got, err := getLatestVersionFrom(server.URL)
		if err != nil {
			t.Errorf("getLatestVersionFrom() error = %v", err)
			return
		}
		want := x64Url
		if runtime.GOARCH != "amd64" {
			want = armUrl
		}
		if got != want {
			t.Errorf("getLatestVersionFrom() got %q, want %q", got, want)
		}
	})

	t.Run("github api status error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer server.Close()

		_, err := getLatestVersionFrom(server.URL)
		if err == nil {
			t.Fatalf("getLatestVersionFrom() expected an error for a 403 response")
		}
		if !strings.Contains(err.Error(), "github api status code: 403") {
			t.Errorf("getLatestVersionFrom() error = %v, want github api status code: 403", err)
		}
	})

	t.Run("no matching asset", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"assets":[{"name":"DepotDownloader_otheros_x64.zip","browser_download_url":"https://example.com/dd/otheros-x64"}]}]`))
		}))
		defer server.Close()

		_, err := getLatestVersionFrom(server.URL)
		if err == nil || !strings.Contains(err.Error(), "failed to find latest version for DepotDownloader") {
			t.Errorf("getLatestVersionFrom() error = %v, want failed to find latest version for DepotDownloader", err)
		}
	})
}
