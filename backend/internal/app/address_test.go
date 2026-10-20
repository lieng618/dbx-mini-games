package app

import (
	"net"
	"testing"
)

// TestReachableOnLanRejectsTunnelAddresses covers the exact address that was advertised on
// this machine: a proxy client's fake-ip range. A peer copying 198.18.0.1 can never
// connect, so it must never be offered.
func TestReachableOnLanRejectsTunnelAddresses(t *testing.T) {
	cases := []struct {
		ip    string
		ok    bool
		label string
	}{
		{"192.168.1.118", true, "a normal LAN address"},
		{"10.0.0.5", true, "a private class A address"},
		{"172.20.1.2", true, "a private class B address"},
		{"198.18.0.1", false, "the proxy fake-ip range that actually broke joining"},
		{"127.0.0.1", false, "loopback is not reachable from a neighbour"},
		{"169.254.10.1", false, "link-local needs no manual entry"},
		{"100.64.1.1", false, "carrier-grade NAT inside tunnels"},
		{"8.8.8.8", false, "a public address is not this machine on the LAN"},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip).To4()
		if ip == nil {
			t.Fatalf("%s is not IPv4", c.ip)
		}
		if got := reachableOnLan(ip); got != c.ok {
			t.Errorf("%s (%s): expected %v, got %v", c.ip, c.label, c.ok, got)
		}
	}
}

// TestOrderAddressesPutsTheReachableOneFirst: a machine with both a WiFi address and a
// corporate one must advertise the WiFi address first. Handing a colleague the 10.x address
// is how "same WiFi but no route to host" happens.
func TestOrderAddressesPutsTheReachableOneFirst(t *testing.T) {
	got := orderAddresses([]addressCandidate{
		{addr: "10.251.1.1:5000", score: 3},
		{addr: "192.168.1.116:5000", score: 0},
		{addr: "192.168.1.116:5000", score: 0}, // duplicate from a second interface
	})
	if len(got) != 2 {
		t.Fatalf("expected duplicates to collapse, got %v", got)
	}
	if got[0] != "192.168.1.116:5000" {
		t.Fatalf("the reachable address must come first, got %v", got)
	}
}

// TestOrderAddressesKeepsTunnelAddresses: a peer on the corporate network needs the 10.x
// address, so ranking must reorder without discarding.
func TestOrderAddressesKeepsTunnelAddresses(t *testing.T) {
	got := orderAddresses([]addressCandidate{
		{addr: "192.168.1.116:5000", score: 0},
		{addr: "10.251.1.1:5000", score: 6},
	})
	if len(got) != 2 {
		t.Fatalf("a tunnel address must still be offered, got %v", got)
	}
	if got[1] != "10.251.1.1:5000" {
		t.Fatalf("the tunnel address belongs last, got %v", got)
	}
}
