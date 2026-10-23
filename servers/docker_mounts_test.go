package servers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
	"github.com/pufferpanel/pufferpanel/v3"
	"github.com/pufferpanel/pufferpanel/v3/config"
	"github.com/pufferpanel/pufferpanel/v3/utils"
)

type containerCreatePayload struct {
	Hostname   string   `json:"Hostname"`
	Env        []string `json:"Env"`
	HostConfig struct {
		Binds []string `json:"Binds"`
	} `json:"HostConfig"`
}

func TestDockerCreateContainerPayload(t *testing.T) {
	forbiddenTimezoneBinds := []string{
		"/etc/timezone:/etc/timezone:ro",
		"/etc/localtime:/etc/localtime:ro",
	}
	payloads := make(chan containerCreatePayload, 1)
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/images/json"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"RepoTags":["test/image:latest"]}]`))
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			var payload containerCreatePayload
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode ContainerCreate payload: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			payloads <- payload
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"Id":"container"}`))
		default:
			t.Errorf("unexpected engine request: %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer engine.Close()

	t.Setenv("DOCKER_HOST", "tcp://"+strings.TrimPrefix(engine.URL, "http://"))
	t.Setenv("DOCKER_API_VERSION", "1.44")
	dockerClient, err := client.New(client.FromEnv)
	if err != nil {
		t.Fatal(err)
	}
	defer dockerClient.Close()

	server, live, _ := newBackupTestServer(t)
	binaryFolder := t.TempDir()
	previousBinariesFolder := config.BinariesFolder.Value()
	if err := config.BinariesFolder.Set(binaryFolder, false); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = config.BinariesFolder.Set(previousBinariesFolder, false) })

	customBind := t.TempDir()
	docker := &Docker{
		ImageName: "test/image",
		Binds: map[string]string{
			customBind: "/custom:ro",
		},
		HostConfig: container.HostConfig{Binds: []string{"/existing:/existing:ro"}},
		Config:     container.Config{Env: []string{"TZ=from-config", "KEEP=config"}, Hostname: "${servername}"},
	}
	environment := &pufferpanel.Environment{Server: server}
	if err := docker.createContainer(environment, pufferpanel.ExecutionData{
		Environment: map[string]string{"TZ": "from-execution"},
		Variables:   map[string]interface{}{"servername": "replaced-host"},
	}, context.Background(), dockerClient); err != nil {
		t.Fatal(err)
	}

	payload := <-payloads
	for _, bind := range payload.HostConfig.Binds {
		if slices.Contains(forbiddenTimezoneBinds, bind) {
			t.Fatalf("ContainerCreate Binds contains panel timezone bind: %#v", payload.HostConfig.Binds)
		}
	}
	for _, bind := range []string{
		utils.ConvertToDockerBind(live.Prefix()) + ":/pufferpanel",
		utils.ConvertToDockerBind(binaryFolder) + ":/var/lib/pufferpanel/binaries:ro",
		utils.ConvertToDockerBind(customBind) + ":/custom:ro",
		"/existing:/existing:ro",
	} {
		if !slices.Contains(payload.HostConfig.Binds, bind) {
			t.Errorf("ContainerCreate Binds = %#v, missing %q", payload.HostConfig.Binds, bind)
		}
	}
	if !slices.Contains(payload.Env, "TZ=from-execution") || slices.Contains(payload.Env, "TZ=from-config") || !slices.Contains(payload.Env, "KEEP=config") {
		t.Errorf("ContainerCreate Env = %#v, want execution TZ precedence and configured environment", payload.Env)
	}
	if payload.Hostname != "replaced-host" {
		t.Errorf("ContainerCreate Hostname = %q, want server variables replaced in the configured hostname", payload.Hostname)
	}
}
