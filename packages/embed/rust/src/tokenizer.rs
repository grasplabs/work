//! The model's tokenizer, as Hugging Face tokenizers runs a Gemma-style BPE: added tokens split first
//! (leftmost-longest on the raw text, with lstrip), then Replace(' ' -> '▁'), Metaspace (prepend always, a word
//! starting at each '▁'), then BPE with ranked merges and byte fallback; `<bos>` in front and `<eos>` behind,
//! truncated as its truncation with the template post-processor truncates.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

const MAGIC_TOK: [u8; 4] = *b"GTOK";
const VERSION: u32 = 1;
const META: [u8; 3] = [0xE2, 0x96, 0x81];

pub struct Tok {
    offs: &'static [u32],
    pieces: &'static [u8],
    moffs: &'static [u32],
    mrank: &'static [u32],
    mlen: &'static [u8],
    byte_id: &'static [u32],
    /// Added tokens by their text: their ID and whether they take the whitespace before them.
    added: HashMap<&'static [u8], (u32, bool)>,
    /// The added tokens' distinct lengths, longest first.
    added_lens: Vec<usize>,
    first: [bool; 256],
    /// The longest piece in the vocabulary, in bytes.
    longest: usize,
    table: Vec<u32>,
    mask: usize,
    bos: u32,
    eos: u32,
}

fn fnv(b: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &c in b {
        h = (h ^ c as u32).wrapping_mul(0x0100_0193);
    }
    h
}

/// `n` little-endian u32s at byte `o` of a 4-aligned blob.
fn words(blob: &'static [u8], o: usize, n: usize) -> Option<&'static [u32]> {
    let bytes = blob.get(o..o.checked_add(n.checked_mul(4)?)?)?;
    // SAFETY: the blob is 4-aligned (the host allocates 16-aligned), and every u32 bit pattern is valid.
    Some(unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const u32, n) })
}

impl Tok {
    /// Reads a tokenizer file (see scripts/export.py), which stays where it is for the life of the tokenizer:
    /// magic, version, bos, eos | n, m, nadd | offs[n+1] | moffs[n+1] | mrank[m] | byte_id[256] | mlen[m] (pad 4) |
    /// added: (id, lstrip, len, bytes, pad 4)* | piece bytes.
    pub fn parse(blob: &'static [u8]) -> Option<Tok> {
        let w = |i: usize| words(blob, i * 4, 1).map(|s| s[0]);
        if blob.get(0..4)? != MAGIC_TOK || w(1)? != VERSION {
            return None;
        }
        let (bos, eos) = (w(2)?, w(3)?);
        let (n, m, nadd) = (w(4)? as usize, w(5)? as usize, w(6)? as usize);
        let mut o = 28;
        let mut arr = |k: usize| -> Option<&'static [u32]> {
            let s = words(blob, o, k)?;
            o += k * 4;
            Some(s)
        };
        let offs = arr(n.checked_add(1)?)?;
        let moffs = arr(n.checked_add(1)?)?;
        let mrank = arr(m)?;
        let byte_id = arr(256)?;
        let mlen = blob.get(o..o.checked_add(m)?)?;
        o = (o + m + 3) & !3;
        let mut added = HashMap::with_capacity(nadd);
        let mut first = [false; 256];
        for _ in 0..nadd {
            let id = words(blob, o, 3)?;
            let l = id[2] as usize;
            let b = blob.get(o + 12..o.checked_add(12 + l)?)?;
            first[*b.first()? as usize] = true;
            added.entry(b).or_insert((id[0], id[1] != 0));
            o = (o + 12 + l + 3) & !3;
        }
        let mut added_lens: Vec<usize> = added.keys().map(|b| b.len()).collect();
        added_lens.sort_unstable_by(|a, b| b.cmp(a));
        added_lens.dedup();
        let pieces = blob.get(o..)?;
        let ids_ok = |s: &[u32], lim: usize| s.iter().all(|&x| (x as usize) < lim);
        let sorted = |s: &[u32]| s.windows(2).all(|p| p[0] <= p[1]);
        let consistent = pieces.len() == offs[n] as usize
            && sorted(offs)
            && sorted(moffs)
            && moffs[n] as usize == m
            && ids_ok(byte_id, n)
            && added.values().all(|a| (a.0 as usize) < n)
            && (bos as usize) < n
            && (eos as usize) < n;
        if !consistent {
            return None;
        }
        let cap = (n * 2).next_power_of_two();
        let mut table = vec![u32::MAX; cap];
        let mask = cap - 1;
        for id in 0..n {
            let p = &pieces[offs[id] as usize..offs[id + 1] as usize];
            let mut h = fnv(p) as usize & mask;
            while table[h] != u32::MAX {
                h = (h + 1) & mask;
            }
            table[h] = id as u32;
        }
        let longest = offs.windows(2).map(|p| (p[1] - p[0]) as usize).max().unwrap_or(1).max(1);
        Some(Tok { offs, pieces, moffs, mrank, mlen, byte_id, added, added_lens, first, longest, table, mask, bos, eos })
    }

    pub fn vocab_size(&self) -> usize {
        self.offs.len() - 1
    }

    fn piece(&self, id: u32) -> &[u8] {
        &self.pieces[self.offs[id as usize] as usize..self.offs[id as usize + 1] as usize]
    }
    fn lookup(&self, b: &[u8]) -> Option<u32> {
        let mut h = fnv(b) as usize & self.mask;
        loop {
            let id = self.table[h];
            if id == u32::MAX {
                return None;
            }
            if self.piece(id) == b {
                return Some(id);
            }
            h = (h + 1) & self.mask;
        }
    }
    /// The merge (a, b) -> (rank, new id), if the merge list has it.
    fn merge(&self, a: u32, b: u32, buf: &mut Vec<u8>) -> Option<(u32, u32)> {
        let (pa, pb) = (self.piece(a), self.piece(b));
        buf.clear();
        buf.extend_from_slice(pa);
        buf.extend_from_slice(pb);
        let r = self.lookup(buf)?;
        let la = pa.len();
        for k in self.moffs[r as usize] as usize..self.moffs[r as usize + 1] as usize {
            if self.mlen[k] as usize == la {
                return Some((self.mrank[k], r));
            }
        }
        None
    }
    fn bpe(&self, w: &[u8], ids: &mut Vec<u32>, buf: &mut Vec<u8>) {
        #[derive(Clone, Copy)]
        struct Sym {
            c: u32,
            prev: i32,
            next: i32,
            gone: bool,
        }
        let mut syms: Vec<Sym> = Vec::with_capacity(w.len());
        let mut i = 0;
        while i < w.len() {
            let b = w[i];
            let l = if b < 0x80 {
                1
            } else if b < 0xE0 {
                2
            } else if b < 0xF0 {
                3
            } else {
                4
            };
            let l = l.min(w.len() - i);
            match self.lookup(&w[i..i + l]) {
                Some(id) => syms.push(Sym { c: id, prev: 0, next: 0, gone: false }),
                None => {
                    for &bb in &w[i..i + l] {
                        syms.push(Sym { c: self.byte_id[bb as usize], prev: 0, next: 0, gone: false });
                    }
                }
            }
            i += l;
        }
        let ns = syms.len();
        for (k, s) in syms.iter_mut().enumerate() {
            s.prev = k as i32 - 1;
            s.next = if k + 1 < ns { k as i32 + 1 } else { -1 };
        }
        let mut heap: BinaryHeap<Reverse<(u32, u32, u32)>> = BinaryHeap::with_capacity(ns);
        for k in 0..ns.saturating_sub(1) {
            if let Some((rank, nid)) = self.merge(syms[k].c, syms[k + 1].c, buf) {
                heap.push(Reverse((rank, k as u32, nid)));
            }
        }
        while let Some(Reverse((_, pos, nid))) = heap.pop() {
            let pos = pos as usize;
            if syms[pos].gone || syms[pos].next == -1 {
                continue;
            }
            let np = syms[pos].next as usize;
            match self.merge(syms[pos].c, syms[np].c, buf) {
                Some((_, id)) if id == nid => {}
                _ => continue,
            }
            let right = syms[np];
            syms[pos].c = nid;
            syms[pos].next = right.next;
            syms[np].gone = true;
            if right.next >= 0 {
                syms[right.next as usize].prev = pos as i32;
            }
            let cur = syms[pos];
            if cur.prev >= 0 {
                if let Some((rank, id)) = self.merge(syms[cur.prev as usize].c, cur.c, buf) {
                    heap.push(Reverse((rank, cur.prev as u32, id)));
                }
            }
            if cur.next >= 0 {
                if let Some((rank, id)) = self.merge(cur.c, syms[cur.next as usize].c, buf) {
                    heap.push(Reverse((rank, pos as u32, id)));
                }
            }
        }
        let mut k = 0i32;
        while k >= 0 && (k as usize) < ns {
            ids.push(syms[k as usize].c);
            k = syms[k as usize].next;
        }
    }
    /// A run of text between added tokens: ' ' -> '▁', '▁' prepended unless there, a word at each '▁'.
    fn piece_ids(&self, s: &[u8], ids: &mut Vec<u32>, max: usize, buf: &mut Vec<u8>) {
        if s.is_empty() {
            return;
        }
        let mut m: Vec<u8> = Vec::with_capacity(s.len() * 3 + 3);
        if !(s[0] == b' ' || s.starts_with(&META)) {
            m.extend_from_slice(&META);
        }
        for &b in s {
            if b == b' ' {
                m.extend_from_slice(&META);
            } else {
                m.push(b);
            }
        }
        let mut st = 0;
        let mut k = 3;
        while k <= m.len() {
            if k == m.len() || m[k..].starts_with(&META) {
                // A token covers at most `longest` bytes, so a word over twice the room left times that fills it: only
                // its start is encoded (bounded work). Texts within the limit never get here and keep the reference's
                // tokens; beyond it, merges near the cut may make the kept tokens differ from the reference's.
                let room = (max - ids.len()).saturating_mul(self.longest).saturating_mul(2);
                let mut end = k;
                if end - st > room {
                    end = st + room;
                    while end > st && m[end] & 0xC0 == 0x80 {
                        end -= 1;
                    }
                }
                self.bpe(&m[st..end], ids, buf);
                if ids.len() >= max {
                    return;
                }
                st = k;
                if k == m.len() {
                    break;
                }
                k += 3;
            } else {
                k += 1;
            }
        }
    }
    /// The longest added token `s` starts with: one hash lookup per distinct added-token length, longest first.
    fn match_added(&self, s: &[u8]) -> Option<(usize, u32, bool)> {
        self.added_lens.iter().find_map(|&len| {
            let &(id, lstrip) = self.added.get(s.get(..len)?)?;
            Some((len, id, lstrip))
        })
    }
    /// `<bos>` + ids + `<eos>`, at most `max` (>= 2) tokens in all. `s` is UTF-8.
    ///
    /// An added token's text in the input (`<eos>`, `<mask>`, `<b>`) becomes that token, deliberately: the reference
    /// tokenizer does the same with raw text.
    pub fn encode(&self, s: &[u8], max: usize) -> Vec<u32> {
        let lim = max - 1;
        let mut ids = vec![self.bos];
        let mut buf = Vec::with_capacity(256);
        let mut start = 0;
        let mut i = 0;
        while i < s.len() && ids.len() < lim {
            if self.first[s[i] as usize] {
                if let Some((len, id, lstrip)) = self.match_added(&s[i..]) {
                    let mut st = i;
                    if lstrip {
                        // An added token with lstrip takes the whitespace before it.
                        // SAFETY: `s` is UTF-8 (the host writes it with TextEncoder), and i is a character
                        // boundary, as an added token starts with a character's first byte.
                        let before = unsafe { core::str::from_utf8_unchecked(&s[..i]) };
                        let ns = before.char_indices().rev().find(|(_, c)| !c.is_whitespace()).map_or(0, |(k, c)| k + c.len_utf8());
                        st = ns.max(start);
                    }
                    if start < st {
                        self.piece_ids(&s[start..st], &mut ids, lim, &mut buf);
                    }
                    if ids.len() < lim {
                        ids.push(id);
                    }
                    i += len;
                    start = i;
                    continue;
                }
            }
            i += 1;
        }
        if start < s.len() && ids.len() < lim {
            self.piece_ids(&s[start..], &mut ids, lim, &mut buf);
        }
        ids.truncate(lim);
        ids.push(self.eos);
        ids
    }
}
