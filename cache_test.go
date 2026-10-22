package pufferpanel

import (
	"bytes"
	"strings"
	"testing"
)

// frozenClockCache builds a cache whose timestamps never advance, which makes
// the same-microsecond races between writes and polls deterministic.
func frozenClockCache(capacityKb int) *MemoryCache {
	c := CreateCache()
	c.Capacity = capacityKb * 1024
	c.now = func() int64 { return 1000 }
	return c
}

// TestReadFromDoesNotSkipWriteInSameMicrosecond is the regression test for the
// console polling loss: a read returned epoch E, a log line was written with a
// wall clock still at E, and the next poll used time > E, so that line was
// never delivered to polling clients (upstream issue #1439 symptom).
func TestReadFromDoesNotSkipWriteInSameMicrosecond(t *testing.T) {
	c := frozenClockCache(50)

	if _, err := c.Write([]byte("first\n")); err != nil {
		t.Fatalf("write first: %v", err)
	}

	_, epoch := c.ReadFrom(0)
	if epoch != 1000 {
		t.Fatalf("expected frozen epoch 1000, got %d", epoch)
	}

	if _, err := c.Write([]byte("second\n")); err != nil {
		t.Fatalf("write second: %v", err)
	}

	logs, _ := c.ReadFrom(epoch)
	if !strings.Contains(string(logs), "second") {
		t.Fatalf("message written after a poll at the same timestamp was skipped, got %q", string(logs))
	}
}

// TestReadFromDoesNotReplayReturnedMessages checks the other side of the
// monotonic epoch: a message already delivered by one poll is not delivered
// again by the next one when timestamps collide.
func TestReadFromDoesNotReplayReturnedMessages(t *testing.T) {
	c := frozenClockCache(50)

	_, err := c.Write([]byte("a\n"))
	if err != nil {
		t.Fatalf("write a: %v", err)
	}
	_, epoch := c.ReadFrom(0)
	_, err = c.Write([]byte("b\n"))
	if err != nil {
		t.Fatalf("write b: %v", err)
	}

	logs, _ := c.ReadFrom(epoch)
	if strings.Contains(string(logs), "a\n") {
		t.Fatalf("already-delivered message replayed to next poll: %q", string(logs))
	}
	if !strings.Contains(string(logs), "b\n") {
		t.Fatalf("new message missing from poll: %q", string(logs))
	}
}

// TestWriteTimestampsAreStrictlyIncreasing verifies consecutive messages never
// share a timestamp, including when the clock stalls or jumps backwards.
func TestWriteTimestampsAreStrictlyIncreasing(t *testing.T) {
	c := CreateCache()
	tick := int64(5000)
	c.now = func() int64 {
		//alternate stalling and moving backwards in time
		if tick%2 == 0 {
			return 5000
		}
		return 5000 - tick
	}

	for i := 0; i < 10; i++ {
		if _, err := c.Write([]byte("x")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	prev := int64(0)
	for i, m := range c.Buffer {
		if m.time <= prev {
			t.Fatalf("message %d timestamp %d not newer than previous %d", i, m.time, prev)
		}
		prev = m.time
	}
}

// TestWriteLargerThanCapacityKeepsCacheBounded covers a single write bigger
// than the whole cache: it must not panic, must be readable once, and must be
// evicted before the next write so the cache stays within its capacity.
func TestWriteLargerThanCapacityKeepsCacheBounded(t *testing.T) {
	c := frozenClockCache(1)

	big := bytes.Repeat([]byte("z"), c.Capacity+128)
	if _, err := c.Write(big); err != nil {
		t.Fatalf("oversize write: %v", err)
	}

	logs, _ := c.Read()
	if len(logs) != len(big) {
		t.Fatalf("oversize message not readable once: got %d bytes, want %d", len(logs), len(big))
	}

	if _, err := c.Write([]byte("next\n")); err != nil {
		t.Fatalf("write after oversize: %v", err)
	}
	if c.Size != len("next\n") {
		t.Fatalf("cache size %d after evicting oversize message, want %d", c.Size, len("next\n"))
	}
	logs, _ = c.Read()
	if !bytes.HasSuffix(logs, []byte("next\n")) || bytes.Contains(logs, []byte("zz")) {
		t.Fatalf("oversize message was not evicted first: %d bytes ending %q", len(logs), logs[len(logs)-8:])
	}
}

// TestReadFromFiltersByStartTime checks the basic incremental-read behavior
// the console API exposes.
func TestReadFromFiltersByStartTime(t *testing.T) {
	c := CreateCache()
	tick := int64(0)
	c.now = func() int64 {
		tick++
		return tick * 10
	}

	_, err := c.Write([]byte("one"))
	if err != nil {
		t.Fatalf("write one: %v", err)
	}
	_, err = c.Write([]byte("two"))
	if err != nil {
		t.Fatalf("write two: %v", err)
	}

	first, epoch := c.ReadFrom(0)
	if string(first) != "onetwo" {
		t.Fatalf("initial read returned %q", string(first))
	}
	if epoch != 30 {
		t.Fatalf("expected epoch 30, got %d", epoch)
	}

	_, err = c.Write([]byte("three"))
	if err != nil {
		t.Fatalf("write three: %v", err)
	}

	next, nextEpoch := c.ReadFrom(epoch)
	if string(next) != "three" {
		t.Fatalf("incremental read returned %q", string(next))
	}
	if nextEpoch <= epoch {
		t.Fatalf("epoch %d did not advance past %d", nextEpoch, epoch)
	}

	old, _ := c.ReadFrom(0)
	if string(old) != "onetwothree" {
		t.Fatalf("full replay returned %q", string(old))
	}
}
