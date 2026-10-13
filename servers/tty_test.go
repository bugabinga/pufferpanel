package servers

import (
	"sync"
	"testing"
	"time"

	"github.com/pufferpanel/pufferpanel/v3"
	"github.com/pufferpanel/pufferpanel/v3/files"
)

func startTestTTY(tb testing.TB, environment *pufferpanel.Environment) *tty {
	tb.Helper()
	implementation, ok := environment.Implementation.(*tty)
	if !ok {
		tb.Fatalf("Implementation = %T, want *tty", environment.Implementation)
	}
	if err := environment.ExecuteAsync(pufferpanel.ExecutionData{Command: "sleep 30"}); err != nil {
		tb.Fatalf("ExecuteAsync() error = %v", err)
	}
	return implementation
}

func stopTestTTY(tb testing.TB, environment *pufferpanel.Environment) {
	tb.Helper()
	if err := environment.Kill(); err != nil {
		tb.Fatalf("Kill() error = %v", err)
	}
	environment.Wait.Lock()
	environment.Wait.Unlock()
}

func newTestTTYEnvironment(tb testing.TB) *pufferpanel.Environment {
	tb.Helper()
	root := tb.TempDir()
	fileServer, err := files.NewFileServer(root, -1, -1, true)
	if err != nil {
		tb.Fatalf("NewFileServer() error = %v", err)
	}
	server := &Server{
		Server:     pufferpanel.Server{Identifier: "tty-test"},
		fileServer: fileServer,
	}
	implementation := &tty{DisableUnshare: true}
	environment := &pufferpanel.Environment{
		ConsoleBuffer:  pufferpanel.CreateCache(),
		Wait:           &sync.Mutex{},
		ConsoleTracker: pufferpanel.CreateTracker(),
		StatusTracker:  pufferpanel.CreateTracker(),
		StatsTracker:   pufferpanel.CreateTracker(),
		Server:         server,
		Implementation: implementation,
	}
	environment.CreateWrapper()
	return environment
}

func TestTTYGetStatsCachesAndResetsForNewProcess(t *testing.T) {
	environment := newTestTTYEnvironment(t)
	implementation := startTestTTY(t, environment)
	t.Cleanup(func() {
		if implementation.mainProcess != nil {
			stopTestTTY(t, environment)
		}
	})

	first, err := environment.GetStats()
	if err != nil {
		t.Fatalf("first GetStats() error = %v", err)
	}
	implementation.statLocker.Lock()
	firstTime := implementation.lastStatTime
	implementation.statLocker.Unlock()
	if firstTime.IsZero() {
		t.Fatal("first GetStats() did not cache a timestamp")
	}

	started := time.Now()
	cached, err := environment.GetStats()
	if err != nil {
		t.Fatalf("cached GetStats() error = %v", err)
	}
	if cached != first {
		t.Fatal("cached GetStats() returned a different result")
	}
	if elapsed := time.Since(started); elapsed >= 500*time.Millisecond {
		t.Fatalf("cached GetStats() took %v, want less than 500ms", elapsed)
	}
	implementation.statLocker.Lock()
	if implementation.lastStatTime != firstTime {
		t.Error("cached GetStats() refreshed cache timestamp")
	}
	implementation.lastStatTime = time.Now().Add(-5 * time.Second)
	implementation.statLocker.Unlock()

	refreshed, err := environment.GetStats()
	if err != nil {
		t.Fatalf("expired GetStats() error = %v", err)
	}
	if refreshed == first {
		t.Fatal("expired GetStats() returned stale result")
	}

	stopTestTTY(t, environment)
	startTestTTY(t, environment)
	current, err := environment.GetStats()
	if err != nil {
		t.Fatalf("new-process GetStats() error = %v", err)
	}
	if current == refreshed {
		t.Fatal("new-process GetStats() returned stale result")
	}
}

func TestTTYLifecycleConcurrentStatusStatsAndRestart(t *testing.T) {
	environment := newTestTTYEnvironment(t)
	for range 3 {
		implementation := startTestTTY(t, environment)
		done := make(chan struct{})
		statusDone := make(chan struct{})
		statsDone := make(chan struct{})
		go func() {
			defer close(statusDone)
			for {
				select {
				case <-done:
					return
				default:
					_, _ = environment.IsRunning()
					_ = environment.SendCode(0)
				}
			}
		}()
		go func() {
			defer close(statsDone)
			_, _ = environment.GetStats()
		}()

		if err := environment.Kill(); err != nil {
			t.Fatalf("Kill() error = %v", err)
		}
		environment.Wait.Lock()
		environment.Wait.Unlock()
		close(done)
		<-statusDone
		<-statsDone
		implementation.lifecycleLocker.RLock()
		running := implementation.mainProcess != nil
		implementation.lifecycleLocker.RUnlock()
		if running {
			t.Fatal("main process remains after restart cycle")
		}
	}
}

func BenchmarkTTYGetStatsCached(b *testing.B) {
	environment := newTestTTYEnvironment(b)
	implementation := startTestTTY(b, environment)
	b.Cleanup(func() {
		if implementation.mainProcess != nil {
			stopTestTTY(b, environment)
		}
	})
	if _, err := environment.GetStats(); err != nil {
		b.Fatalf("GetStats() error = %v", err)
	}

	b.ResetTimer()
	for b.Loop() {
		if _, err := environment.GetStats(); err != nil {
			b.Fatalf("GetStats() error = %v", err)
		}
	}
}
