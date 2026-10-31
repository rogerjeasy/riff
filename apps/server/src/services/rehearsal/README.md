# Rehearsal

The first increment is a bounded synthetic replay service for the reviewed Tomato
Toss artifact. It owns per-request engine state and cancellation, accepts no live
sinks or arbitrary source, and permits one active replay per application.
Snapshots, scenario scrubbing and counterexamples remain future work.
