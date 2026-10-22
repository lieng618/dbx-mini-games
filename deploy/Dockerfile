FROM golang:1.27-alpine AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/dbx-mini-games-server .

FROM alpine:3.22

RUN addgroup -S games && adduser -S -G games games
COPY --from=build /out/dbx-mini-games-server /usr/local/bin/dbx-mini-games-server

USER games
EXPOSE 8787
ENV DBX_MINI_GAMES_ADDR=:8787
ENTRYPOINT ["/usr/local/bin/dbx-mini-games-server"]
