package discovery

import "testing"

// TestAddressRankPrefersDialable proves the dedupe keeps the address a neighbour can use.
func TestAddressRankPrefersDialable(t *testing.T) {
	if addressRank("192.168.1.118:5000") <= addressRank("198.18.0.1:5000") {
		t.Fatal("a private address must outrank a fake-ip address")
	}
	if addressRank("192.168.1.118:5000") <= addressRank("127.0.0.1:5000") {
		t.Fatal("a private address must outrank loopback")
	}
	if !preferred(RoomInfo{Address: "192.168.1.118:5000"}, RoomInfo{Address: "198.18.0.1:5000"}) {
		t.Fatal("preferred must pick the private address")
	}
}
