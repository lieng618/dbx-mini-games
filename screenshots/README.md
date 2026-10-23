# Screenshots

## Store listings

The `store-*.png` files are store-ready captures of the public service at
`https://1.92.64.227`. Every image is 1280x720 and shows a real online state,
not a static mock.

| File | Content |
| --- | --- |
| `store-01-lobby.png` | Desktop lobby |
| `store-02-create-room.png` | Room creation, access mode, total time, and per-move limit |
| `store-03-waiting-room.png` | Waiting room with one empty seat |
| `store-04-players-ready.png` | Both seats occupied and ready to start |
| `store-05-gomoku-start.png` | Gomoku opening with the current turn and action bar |
| `store-06-gomoku-match.png` | Gomoku match in progress |
| `store-07-opponent-view.png` | Gomoku from the second player's seat |
| `store-08-result-card.png` | Finished-match result card |
| `store-09-xiangqi-match.png` | Chinese chess opening |
| `store-10-xiangqi-move.png` | Chinese chess with the previous move highlighted |
| `store-11-xiangqi-opponent-view.png` | Chinese chess from the second player's seat |
| `store-12-settings.png` | Nickname, low-motion, effects, board-size, and theme settings |

## Mobile evidence

`last-move-mobile.png` is a 585x1266 mobile capture kept as layout evidence; it
is not a store listing image. `last-move-replay.png` is a 2160x1350 desktop
feature capture and likewise does not replace a 1280x720 store image.

## Regression and feature evidence

The `undo-*.png` and `opponent-left.png` files document feature behavior rather
than store listings. Additional password, settlement, and replay checks are in
`regression/`. `settings-nickname.png` is an earlier settings-page working
capture; `store-12-settings.png` is the current store-ready version.
