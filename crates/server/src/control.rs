//! Private desktop control pipe, not the MCP transport. No request data is written to it.
use serde_json::Value;
use std::io::{self, Read, Write};
use tokio_util::sync::CancellationToken;

pub fn emit(value: Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "[CTL] {value}")?;
    out.flush()
}

fn read_until_stop(mut input: impl Read) {
    let mut buf = [0u8; 1024];
    let mut line = Vec::new();
    let mut discard = false;
    loop {
        let n = match input.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        for &byte in &buf[..n] {
            if byte == b'\n' {
                if !discard
                    && serde_json::from_slice::<Value>(&line).ok().and_then(|v| {
                        v.get("type")
                            .and_then(Value::as_str)
                            .map(|s| s == "shutdown")
                    }) == Some(true)
                {
                    return;
                }
                line.clear();
                discard = false;
            } else if !discard {
                if line.len() < 4096 {
                    line.push(byte)
                } else {
                    discard = true;
                    line.clear();
                }
            }
        }
    }
}

pub fn watch_parent(stop: CancellationToken) -> io::Result<()> {
    std::thread::Builder::new()
        .name("desktop-control".into())
        .spawn(move || {
            read_until_stop(io::stdin().lock());
            stop.cancel();
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_and_oversized_lines_do_not_become_commands() {
        let mut bytes = vec![b' '; 4300];
        bytes.extend_from_slice(
            b"{\"type\":\"shutdown\"}\nnot-json\n{\"type\":\"other\"}\n{\"type\":\"shutdown\"}\r\n",
        );
        // Restrict read size to prove that the actual shutdown, not EOF or the discarded tail, ended the loop.
        struct ByteReader<'a>(&'a [u8]);
        impl Read for ByteReader<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                self.0.read(&mut out[..1])
            }
        }
        bytes.extend_from_slice(b"after");
        let mut input = ByteReader(bytes.as_slice());
        read_until_stop(&mut input);
        assert_eq!(input.0, b"after");
    }
}
