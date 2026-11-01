# Firebot configuration boundary

F39 explicitly recognizes native Firebot imports as unsupported. Import never executes
C#, shell commands, plugins or scripts. The production panel accepts only the versioned
`riff-production` mapping document and displays unsupported fields/formats before approval.

There is no live Firebot transport or native migration in this increment. See
[the production service](../../services/production/README.md) for the supported OBS and
Streamer.bot connections, reviewed operations and configuration format.
