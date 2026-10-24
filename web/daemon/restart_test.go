package daemon

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pufferpanel/pufferpanel/v3"
	"github.com/pufferpanel/pufferpanel/v3/servers"
)

// restartRaceEnvironment mimics how the real environments report process
// termination: the process is "running" until console input or a kill stops
// it, then the implementation flags itself as not running and fires the
// after-exit callback, which keeps the server running lock until
// post-execution steps finish.
type restartRaceEnvironment struct {
	mu      sync.Mutex
	running bool
	stopped bool
	stop    chan struct{}
	exits   atomic.Int32
}

func (f *restartRaceEnvironment) ExecuteAsyncImpl(environment *pufferpanel.Environment, steps pufferpanel.ExecutionData) error {
	f.mu.Lock()
	if f.running {
		f.mu.Unlock()
		return pufferpanel.ErrProcessRunning
	}
	f.running = true
	f.stopped = false
	f.stop = make(chan struct{})
	f.mu.Unlock()

	go func() {
		<-f.stop
		f.mu.Lock()
		f.running = false
		f.mu.Unlock()
		environment.Wait.Unlock()
		steps.Callback(0)
		f.exits.Add(1)
	}()
	return nil
}

func (f *restartRaceEnvironment) triggerExit() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.stopped && f.stop != nil {
		f.stopped = true
		close(f.stop)
	}
}

func (f *restartRaceEnvironment) KillImpl(*pufferpanel.Environment) error {
	f.triggerExit()
	return nil
}

func (f *restartRaceEnvironment) GetStatsImpl(*pufferpanel.Environment) (*pufferpanel.ServerStats, error) {
	return nil, nil
}

func (f *restartRaceEnvironment) SendCodeImpl(*pufferpanel.Environment, int) error { return nil }

func (f *restartRaceEnvironment) GetUidImpl(*pufferpanel.Environment) int { return -1 }

func (f *restartRaceEnvironment) GetGidImpl(*pufferpanel.Environment) int { return -1 }

func (f *restartRaceEnvironment) IsRunningImpl(*pufferpanel.Environment) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running, nil
}

// stopConsole routes ExecuteInMainProcess input to the fake process as a stop
// request, the way a real console "stop" command ends the main process.
type stopConsole struct {
	env *restartRaceEnvironment
}

func (c stopConsole) Write(p []byte) (int, error) {
	c.env.triggerExit()
	return len(p), nil
}

func (stopConsole) Close() error { return nil }

func (stopConsole) Start() {}

func newRestartRaceServer(t *testing.T) (*servers.Server, *restartRaceEnvironment) {
	t.Helper()
	impl := &restartRaceEnvironment{}
	server := servers.CreateProgram()
	server.Identifier = "restart-race-test"
	server.Execution.Command = "fake"
	server.Execution.StopCommand = "stop"
	//post-execution holds the server running lock for a while after the
	//process exits, which is the window the old doRestart poll missed
	server.Execution.PostExecution = []pufferpanel.ConditionalMetadataType{
		{
			MetadataType: pufferpanel.MetadataType{
				Type: "sleep",
				Metadata: map[string]interface{}{
					"duration": "500ms",
				},
			},
		},
	}
	server.RunningEnvironment = &pufferpanel.Environment{
		Type:           "fake",
		Wait:           &sync.Mutex{},
		ConsoleBuffer:  pufferpanel.CreateCache(),
		ConsoleTracker: pufferpanel.CreateTracker(),
		StatusTracker:  pufferpanel.CreateTracker(),
		Implementation: impl,
		Console:        stopConsole{env: impl},
	}
	return server, impl
}

func waitForRunningState(t *testing.T, impl *restartRaceEnvironment, want bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		running, err := impl.IsRunningImpl(nil)
		if err != nil {
			t.Fatalf("IsRunning error: %s", err)
		}
		if running == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("process never reached running=%v", want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestDoRestartWaitsForPostExecution reproduces the restart race: the
// environment reports the process as gone immediately at exit, while the
// after-exit handler still holds the server running lock during
// post-execution steps. doRestart must keep retrying Start until the lock
// frees instead of failing with ErrServerRunning.
func TestDoRestartWaitsForPostExecution(t *testing.T) {
	server, impl := newRestartRaceServer(t)

	if err := server.Start(); err != nil {
		t.Fatalf("initial Start failed: %s", err)
	}
	waitForRunningState(t, impl, true)

	if err := doRestart(server, 30*time.Second); err != nil {
		t.Fatalf("doRestart failed: %s", err)
	}
	waitForRunningState(t, impl, true)

	//end the second run and let its after-exit handler finish before
	//returning, so no goroutine outlives the test
	if err := server.Stop(); err != nil {
		t.Fatalf("final Stop failed: %s", err)
	}
	waitForRunningState(t, impl, false)
	deadline := time.Now().Add(10 * time.Second)
	for impl.exits.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("second after-exit handler never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
