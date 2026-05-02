# /diagnose — Diagnose the latest (or a specific) sort/filter failure

Reads `server/.debug/index.jsonl` to find the most recent runId, then invokes the `jaal-diagnostician` subagent to inspect the debug artifacts and report what went wrong.

## Usage

```
/diagnose                        # inspect the most recent /analyze run
/diagnose ana_20260428T142301Z_a3f9k2   # inspect a specific runId (from browser console)
```

## Steps

1. If a runId argument was given, use it directly. Otherwise, read the last line of `server/.debug/index.jsonl` (at `D:\Dev\Jaal\server\.debug\index.jsonl`) to extract the runId.
2. Confirm the directory `server/.debug/<runId>/` exists and list its files.
3. Run the `jaal-diagnostician` subagent with the runId and the file listing.
4. Report the diagnosis, evidence, and recommended fix to the user.
