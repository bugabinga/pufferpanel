package servers

import (
	"context"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/pufferpanel/pufferpanel/v3"
)

func TestCreateDockerEnvironmentDefaults(t *testing.T) {
	docker, ok := CreateDockerEnvironment().(*Docker)
	if !ok {
		t.Fatalf("CreateDockerEnvironment() = %T, want *Docker", CreateDockerEnvironment())
	}
	if docker.ImageName != "pufferpanel/generic" {
		t.Errorf("ImageName = %q, want pufferpanel/generic", docker.ImageName)
	}
	if docker.Network != "host" {
		t.Errorf("Network = %q, want host", docker.Network)
	}
	if docker.Ports == nil || len(docker.Ports) != 0 {
		t.Errorf("Ports = %#v, want empty slice", docker.Ports)
	}
	if docker.Binds == nil || len(docker.Binds) != 0 {
		t.Errorf("Binds = %#v, want empty map", docker.Binds)
	}
	if docker.Labels == nil || len(docker.Labels) != 0 {
		t.Errorf("Labels = %#v, want empty map", docker.Labels)
	}
}

func TestCreateEnvironmentDockerMetadata(t *testing.T) {
	server := &Server{Server: pufferpanel.Server{
		Identifier: "docker-test",
		Environment: pufferpanel.MetadataType{Type: "docker", Metadata: map[string]interface{}{
			"image":       "custom/image:tag",
			"networkName": "bridge",
		}},
	}}
	environment, err := CreateEnvironment("docker", "/tmp/servers", "/tmp/backups", server)
	if err != nil {
		t.Fatalf("CreateEnvironment() error = %v", err)
	}
	docker, ok := environment.Implementation.(*Docker)
	if !ok {
		t.Fatalf("Implementation = %T, want *Docker", environment.Implementation)
	}
	if docker.ImageName != "custom/image:tag" || docker.Network != "bridge" {
		t.Errorf("metadata overrides not applied: image=%q network=%q", docker.ImageName, docker.Network)
	}
	if docker.Ports == nil || docker.Binds == nil || docker.Labels == nil {
		t.Errorf("default empty collections lost: ports=%#v binds=%#v labels=%#v", docker.Ports, docker.Binds, docker.Labels)
	}
}

func TestDockerCreateContainerRejectsInvalidStdinPortBeforeDocker(t *testing.T) {
	server, _, _ := newBackupTestServer(t)
	environment := &pufferpanel.Environment{Server: server}
	_, want := network.ParsePort("invalid/tcp")
	if want == nil {
		t.Fatal("network.ParsePort accepted invalid/tcp")
	}

	err := (&Docker{ImageName: "must-not-pull"}).createContainer(environment, pufferpanel.ExecutionData{
		StdInConfig: pufferpanel.StdinConsoleConfiguration{Port: "invalid"},
	}, context.Background(), nil)
	if err == nil || err.Error() != want.Error() {
		t.Fatalf("createContainer() error = %v, want %v", err, want)
	}
}

func TestDockerGetGidWithoutGroupDoesNotPanic(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("GetGidImpl panicked for user without group: %v", recovered)
		}
	}()
	if got := (&Docker{Config: container.Config{User: "1000"}}).GetGidImpl(nil); got != -1 {
		t.Errorf("GetGidImpl() = %d, want -1", got)
	}
}
