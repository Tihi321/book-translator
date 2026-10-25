---
kind: puzzles
puzzles:
  - key: dinner
    kind: murdle
    title: Death in the Library
    chapter: 2
    verified: { unique: true, deducible: true, score: 3, textChecked: true, by: vno_puzzle_generate }
    hints: true
    onFail: { mode: retry }
    core:
      format: 1
      seed: 4242
      band: easy
      difficulty: { steps: 4, score: 3, rules: {} }
      steps: []
      kind: murdle
      size: 3
      categories:
        - { key: suspect, items: [s1, s2, s3] }
        - { key: weapon, items: [w1, w2, w3] }
        - { key: place, items: [p1, p2, p3] }
      solution:
        s1: { weapon: w1, place: p1 }
        s2: { weapon: w2, place: p2 }
        s3: { weapon: w3, place: p3 }
      clues:
        - { id: c1, type: is, a: s1, b: w1 }
        - { id: c2, type: is, a: s2, b: w2 }
        - { id: c3, type: is, a: s1, b: p1 }
        - { id: c4, type: is, a: s2, b: p2 }
      murder:
        place: p1
        answer: { suspect: s1, weapon: w1, place: p1 }
    names:
      s1: Colonel Ash
      s2: Miss Cole
      s3: Doctor Birch
      w1: rope
      w2: poison
      w3: candlestick
      p1: library
      p2: kitchen
      p3: garden
    text:
      c1: Colonel Ash had the rope.
      c2: Miss Cole had the poison.
      c3: Colonel Ash was in the library.
      c4: Miss Cole was in the kitchen.
      murder: The body was found in the library.
    clueAt: { c1: 1, c2: 1, c3: 1, c4: 1 }
---

The Dinner Party (dinner, murdle, chapter 2). The truth: suspect: Colonel Ash, weapon: rope, place: library.

- c1 (chapter 1): Colonel Ash had the rope.
- c2 (chapter 1): Miss Cole had the poison.
- c3 (chapter 1): Colonel Ash was in the library.
- c4 (chapter 1): Miss Cole was in the kitchen.
- murder: The body was found in the library.
