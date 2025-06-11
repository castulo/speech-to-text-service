# Speech-to-Text Service

## Getting Started

1. Install the service
```
yarn install
```

2. Start the server
```
yarn start
```

3. You can now send a request to transcribe an audio file with speech. E.g.
```
curl -X POST http://<service_ip>:3001/transcribe -F "audio=@sample.m4a;type=audio/m4a"
```
