package servers

import (
	"testing"

	"github.com/pufferpanel/pufferpanel/v3"
)

func TestCreateEnvironmentDocker(t *testing.T) {
	environment, err := CreateEnvironment("docker", "/tmp/servers", "/tmp/backups", &Server{Server: pufferpanel.Server{Identifier: "docker-test", Environment: pufferpanel.MetadataType{Metadata: map[string]interface{}{}}}})
	if err != nil {
		t.Fatalf("CreateEnvironment() error = %v", err)
	}
	if environment == nil {
		t.Fatal("CreateEnvironment() returned nil environment")
	}
	if _, ok := environment.Implementation.(*Docker); !ok {
		t.Fatalf("Implementation = %T, want *Docker", environment.Implementation)
	}
}

func TestCreateEnvironmentUnknownType(t *testing.T) {
	environment, err := CreateEnvironment("unknown", "/tmp/servers", "/tmp/backups", &Server{Server: pufferpanel.Server{Identifier: "unknown-test"}})
	if err == nil {
		t.Fatal("CreateEnvironment() error = nil, want undefined environment error")
	}
	if environment != nil {
		t.Errorf("CreateEnvironment() environment = %#v, want nil", environment)
	}
}
