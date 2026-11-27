package pufferpanel

import (
	"bytes"
	"errors"
	"fmt"
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

// TestConsoleSinksAgreeOnWriteOrder is the regression test for the console
// write race: process output flows through environment.Wrapper while
// lifecycle messages go through DisplayToConsole, and both write to the
// console buffer and the live tracker as two independently locked sinks.
// Without a shared lock, the buffer could record "proc then life" while a
// live websocket client received "life then proc", so the live console and
// the history a client gets after a refresh disagreed about the order.
func TestConsoleSinksAgreeOnWriteOrder(t *testing.T) {
	environment := &Environment{}
	environment.ConsoleBuffer = CreateCache()
	environment.ConsoleTracker = CreateTracker()
	environment.CreateWrapper()

	socket, client := newSocketPair(t)
	environment.ConsoleTracker.Register(socket)
	_ = socket

	const rounds = 300

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			if _, err := fmt.Fprintf(environment.Wrapper, "proc %d\n", i); err != nil {
				t.Errorf("write process output: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			environment.DisplayToConsole(true, "life %d\n", i)
		}
	}()
	wg.Wait()

	history, _ := environment.ConsoleBuffer.Read()

	var live bytes.Buffer
	for i := 0; i < 2*rounds; i++ {
		_ = client.SetReadDeadline(time.Now().Add(30 * time.Second))
		frame := readFrame(t, client)
		live.Write(frame.Data.Logs)
	}

	if !bytes.Equal(history, live.Bytes()) {
		t.Fatalf("console history and live console disagree on order:\nhistory:\n%s\nlive:\n%s", history, live.Bytes())
	}
}
