package pufferpanel

import (
	"github.com/pufferpanel/pufferpanel/v3/config"
	"sync"
	"time"
)

type cacheMessage struct {
	msg  []byte
	time int64
}

type MemoryCache struct {
	Buffer   []cacheMessage
	Capacity int
	Size     int
	Lock     sync.RWMutex
}

func CreateCache() *MemoryCache {
	capacity := config.ConsoleBuffer.Value()
	if capacity <= 0 {
		capacity = 50
	}
	return &MemoryCache{
		Buffer:   make([]cacheMessage, 0),
		Capacity: capacity * 1024, //convert to KB
	}
}

func (c *MemoryCache) Read() (msg []byte, lastTime int64) {
	msg, lastTime = c.ReadFrom(0)
	return
}

func (c *MemoryCache) ReadFrom(startTime int64) (msg []byte, lastTime int64) {
	c.Lock.RLock()
	defer c.Lock.RUnlock()

	lastTime = time.Now().UnixMicro()

	msg = make([]byte, 0)

	for _, v := range c.Buffer {
		if v.time > startTime {
			msg = append(msg, v.msg...)
		}
	}

	return
}

func (c *MemoryCache) Write(b []byte) (n int, err error) {
	c.Lock.Lock()
	defer c.Lock.Unlock()
	n = len(b)

	//remove data until we've gotten small enough
	//a single write larger than the whole capacity empties the buffer and must
	//not index into it; that oversize message is kept once and evicted first
	//on the next write, so the cache stays bounded without panicking
	var pop cacheMessage
	for c.Size+n > c.Capacity && len(c.Buffer) > 0 {
		pop, c.Buffer = c.Buffer[0], c.Buffer[1:]
		c.Size = c.Size - len(pop.msg)
	}

	co := make([]byte, len(b))
	copy(co, b)

	c.Buffer = append(c.Buffer, cacheMessage{msg: co, time: time.Now().UnixMicro()})
	c.Size = c.Size + n
	return
}
