package utils

import (
	"testing"

	"github.com/moby/moby/api/types/container"
)

func TestCalculateDockerCPUPercent(t *testing.T) {
	for _, test := range []struct {
		name     string
		current  container.CPUStats
		previous container.CPUStats
		want     float64
	}{
		{name: "missing sample"},
		{name: "zero system delta", current: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 20}, SystemUsage: 100, OnlineCPUs: 4}, previous: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 10}, SystemUsage: 100}},
		{name: "reset CPU counter", current: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 5}, SystemUsage: 200, OnlineCPUs: 4}, previous: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 10}, SystemUsage: 100}},
		{name: "reset system counter", current: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 20}, SystemUsage: 50, OnlineCPUs: 4}, previous: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 10}, SystemUsage: 100}},
		{name: "online CPUs", current: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 20}, SystemUsage: 300, OnlineCPUs: 4}, previous: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 10}, SystemUsage: 100}, want: 20},
		{name: "per CPU fallback", current: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 20, PercpuUsage: []uint64{10, 10}}, SystemUsage: 300}, previous: container.CPUStats{CPUUsage: container.CPUUsage{TotalUsage: 10}, SystemUsage: 100}, want: 10},
	} {
		t.Run(test.name, func(t *testing.T) {
			stats := &container.StatsResponse{CPUStats: test.current, PreCPUStats: test.previous}
			if got := CalculateDockerCPUPercent(stats); got != test.want {
				t.Fatalf("CalculateDockerCPUPercent() = %v, want %v", got, test.want)
			}
		})
	}
}
