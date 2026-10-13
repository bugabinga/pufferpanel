package pufferpanel

import (
	"errors"
	"sync"
	"testing"
	"time"
)

type waitEnvironment struct {
	running   bool
	killErr   error
	kill      func()
	killCalls int
}

func (w *waitEnvironment) ExecuteAsyncImpl(*Environment, ExecutionData) error { return nil }
func (w *waitEnvironment) KillImpl(*Environment) error {
	w.killCalls++
	if w.kill != nil {
		w.kill()
	}
	return w.killErr
}
func (*waitEnvironment) GetStatsImpl(*Environment) (*ServerStats, error) { return nil, nil }
func (*waitEnvironment) SendCodeImpl(*Environment, int) error            { return nil }
func (*waitEnvironment) GetUidImpl(*Environment) int                     { return -1 }
func (*waitEnvironment) GetGidImpl(*Environment) int                     { return -1 }
func (w *waitEnvironment) IsRunningImpl(*Environment) (bool, error)      { return w.running, nil }

func TestWaitForMainProcessForKillsAfterTimeout(t *testing.T) {
	killErr := errors.New("kill failed")
	implementation := &waitEnvironment{running: true, killErr: killErr}
	environment := &Environment{Wait: &sync.Mutex{}, Implementation: implementation}
	environment.Wait.Lock()
	implementation.kill = environment.Wait.Unlock

	started := time.Now()
	if err := environment.WaitForMainProcessFor(20 * time.Millisecond); !errors.Is(err, killErr) {
		t.Fatalf("WaitForMainProcessFor() error = %v, want kill error %v", err, killErr)
	}
	if elapsed := time.Since(started); elapsed < 20*time.Millisecond {
		t.Fatalf("WaitForMainProcessFor() returned after %v, before timeout", elapsed)
	}
	if implementation.killCalls != 1 {
		t.Fatalf("Kill() calls = %d, want 1", implementation.killCalls)
	}
}

func TestWaitForMainProcessForDoesNotKillNaturalExit(t *testing.T) {
	implementation := &waitEnvironment{running: true}
	environment := &Environment{Wait: &sync.Mutex{}, Implementation: implementation}
	environment.Wait.Lock()

	go func() {
		time.Sleep(10 * time.Millisecond)
		environment.Wait.Unlock()
	}()

	started := time.Now()
	if err := environment.WaitForMainProcessFor(100 * time.Millisecond); err != nil {
		t.Fatalf("WaitForMainProcessFor() error = %v, want nil", err)
	}
	if elapsed := time.Since(started); elapsed >= 100*time.Millisecond {
		t.Fatalf("WaitForMainProcessFor() returned after %v, want natural exit before timeout", elapsed)
	}
	if implementation.killCalls != 0 {
		t.Fatalf("Kill() calls = %d, want 0", implementation.killCalls)
	}
}
