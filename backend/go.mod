module github.com/jzj2621899857/dbx-board-games/backend

go 1.26.0

require github.com/grandcat/zeroconf v1.0.0

require (
	github.com/cenkalti/backoff v2.2.1+incompatible // indirect
	github.com/miekg/dns v1.1.27 // indirect
	github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk v0.0.0-20261019041224-6a2caa508389 // indirect
	golang.org/x/crypto v0.58.0 // indirect
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
)

replace github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk => ./third_party/dbx-plugin-sdk
