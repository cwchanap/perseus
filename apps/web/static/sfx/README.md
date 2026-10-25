# Gameplay sound effects

Generated with ElevenLabs sound effects (`eleven_text_to_sound_v2`), then trimmed of leading
silence, cut short with a fade-out, loudness-normalized and re-encoded as mono 96 kbps MP3 with
ffmpeg:

```bash
ffmpeg -i take.mp3 -af "silenceremove=start_periods=1:start_threshold=-50dB,atrim=0:<secs>,afade=t=out:st=<secs-0.08>:d=0.08,loudnorm=I=-16:TP=-2:LRA=11" -ac 1 -ar 44100 -b:a 96k <name>.mp3
```

| File           | Plays when                   | Cut (s) | Prompt                                                                                                             |
| -------------- | ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `pickup.mp3`   | A piece is selected          | 0.7     | Short soft synth UI blip, light airy pluck, close-mic, very brief                                                  |
| `snap.mp3`     | A placement is accepted      | 1.0     | Satisfying crisp click snapping into place, followed by a tiny bright synth chime, short                           |
| `wrong.mp3`    | A placement is rejected      | 0.65    | Soft low muted synth buzz, gentle error tone, two quick descending notes, short                                    |
| `rotate.mp3`   | A piece is rotated           | 0.75    | Tiny quick airy swish, soft whoosh, very short                                                                     |
| `hint.mp3`     | A hint is used               | 0.85    | Short magical sparkle shimmer, bright twinkling glints, soft                                                       |
| `complete.mp3` | The puzzle completion seals  | 1.9     | Short rising retro synth arcade fanfare, triumphant bright arpeggio ending on a shimmering chord, under two seconds |
