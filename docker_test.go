package pufferpanel

import (
	"sync"
	"testing"
)

func TestGetDockerClientConcurrentInitialization(t *testing.T) {
	dockerClientMutex.Lock()
	previous := dockerClient
	dockerClient = nil
	dockerClientMutex.Unlock()
	t.Cleanup(func() {
		dockerClientMutex.Lock()
		created := dockerClient
		dockerClient = previous
		dockerClientMutex.Unlock()
		if created != nil {
			_ = created.Close()
		}
	})

	const callers = 32
	clients := make(chan struct {
		client interface{ Close() error }
		err    error
	}, callers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			client, err := GetDockerClient()
			clients <- struct {
				client interface{ Close() error }
				err    error
			}{client, err}
		}()
	}
	close(start)
	wg.Wait()
	close(clients)

	var first interface{ Close() error }
	for result := range clients {
		if result.err != nil {
			t.Fatalf("GetDockerClient() error = %v", result.err)
		}
		if first == nil {
			first = result.client
			continue
		}
		if result.client != first {
			t.Error("GetDockerClient() returned different clients")
		}
	}
}
