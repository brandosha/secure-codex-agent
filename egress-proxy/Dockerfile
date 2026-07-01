FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -o /out/proxy-policy-compiler ./cmd/proxy-policy-compiler


FROM envoyproxy/envoy:v1.33-latest
WORKDIR /app

COPY --from=build /out/proxy-policy-compiler /usr/local/bin/proxy-policy-compiler
COPY entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
