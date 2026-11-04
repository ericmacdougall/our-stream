// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fitWithin, gopFrames, selectLadder } from './ladder.js';
import { interpretProbe, parseFps } from './ffprobe.js';
import { planHls } from './hls.js';

describe('selectLadder', () => {
  it('builds the vertical ladder for a 1080x1920 source', () => {
    const l = selectLadder(1080, 1920);
    expect(l.map((r) => [r.name, r.width, r.height, r.bitrate])).toEqual([
      ['1080p', 1080, 1920, 5_500_000],
      ['720p', 720, 1280, 2_800_000],
      ['540p', 540, 960, 1_400_000],
      ['360p', 360, 640, 600_000],
    ]);
    expect(l[0]?.playlist).toBe('hls/1080p/index.m3u8');
  });
  it('builds the horizontal ladder for a 1920x1080 source', () => {
    expect(selectLadder(1920, 1080).map((r) => [r.width, r.height])).toEqual([
      [1920, 1080],
      [1280, 720],
      [960, 540],
      [640, 360],
    ]);
  });
  it('never upscales: a 720x1280 source has no 1080p tier', () => {
    const names = selectLadder(720, 1280).map((r) => r.name);
    expect(names).toEqual(['720p', '540p', '360p']);
    expect(selectLadder(1280, 720).map((r) => r.name)).toEqual(['720p', '540p', '360p']);
  });
  it('fits odd aspect ratios inside the tier box with even dimensions', () => {
    const l = selectLadder(1440, 1080); // 4:3
    expect(l[0]).toMatchObject({ name: '720p', width: 960, height: 720 });
    const sq = selectLadder(1000, 1000);
    expect(sq[0]).toMatchObject({ name: '540p', width: 540, height: 540 });
  });
  it('gives a tiny source a single rendition at its own size', () => {
    expect(selectLadder(320, 240)).toEqual([
      {
        name: 'source',
        width: 320,
        height: 240,
        bitrate: 600_000,
        playlist: 'hls/source/index.m3u8',
      },
    ]);
    expect(selectLadder(321, 241)[0]).toMatchObject({ width: 322, height: 242 });
  });
  it('fitWithin never enlarges and keeps even pixels', () => {
    expect(fitWithin(100, 50, 1000, 1000)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(1001, 601, 500, 500)).toEqual({ width: 500, height: 300 });
  });
  it('gopFrames is two seconds of frames with a 30 fps fallback', () => {
    expect(gopFrames(30)).toBe(60);
    expect(gopFrames(29.97)).toBe(60);
    expect(gopFrames(25)).toBe(50);
    expect(gopFrames(null)).toBe(60);
  });
});

describe('interpretProbe', () => {
  const base = { format: { duration: '12.000000', format_name: 'mov,mp4' } };
  it('swaps dimensions for rotated video and reads fps', () => {
    const info = interpretProbe({
      ...base,
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30000/1001',
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true, durationMs: 12_000 });
    expect(info.fps).toBeCloseTo(29.97, 2);
  });
  it('ignores attached pictures and handles audio-only input', () => {
    const info = interpretProbe({
      ...base,
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
        { codec_type: 'audio', codec_name: 'mp3', duration: '12.0' },
      ],
    });
    expect(info).toMatchObject({ hasVideo: false, hasAudio: true, width: null, height: null });
  });
  it('rejects streams without duration or dimensions', () => {
    expect(() => interpretProbe({ streams: [] })).toThrow(/no audio or video/);
    expect(() => interpretProbe({ format: {}, streams: [{ codec_type: 'audio' }] })).toThrow(
      /duration/,
    );
    expect(() =>
      interpretProbe({ ...base, streams: [{ codec_type: 'video', width: 0, height: 0 }] }),
    ).toThrow(/dimensions/);
    expect(parseFps('0/0')).toBeNull();
    expect(parseFps(undefined)).toBeNull();
  });
});

describe('planHls', () => {
  const video = {
    durationMs: 12_000,
    hasVideo: true,
    hasAudio: true,
    width: 720,
    height: 1280,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
  };
  it('emits the ADR-0003 encoder flags for every rendition and a named var_stream_map', () => {
    const plan = planHls(video, '/in.mp4', '/out', { threads: 4 });
    const a = plan.args.join(' ');
    expect(plan.renditions.map((r) => r.name)).toEqual(['720p', '540p', '360p']);
    expect(a).toContain('-g 60 -keyint_min 60 -sc_threshold 0');
    expect(a).toContain('-hls_time 4');
    expect(a).toContain('-hls_segment_type fmp4');
    expect(a).toContain('-hls_flags independent_segments');
    expect(a).toContain('-c:a aac -b:a 128000');
    expect(a).toContain('-threads 4');
    expect(a).toContain('-var_stream_map v:0,a:0,name:720p v:1,a:1,name:540p v:2,a:2,name:360p');
    expect(a).toContain('-master_pl_name master.m3u8');
    expect(a).toContain('[0:v:0]split=3[v0][v1][v2];[v0]scale=720:1280');
    expect(plan.audioOnly).toBeNull();
  });
  it('produces an audio-only rendition for audio uploads', () => {
    const plan = planHls(
      { ...video, hasVideo: false, width: null, height: null, fps: null },
      '/in.mp3',
      '/out',
      { threads: 2 },
    );
    expect(plan.renditions).toEqual([]);
    expect(plan.audioOnly).toMatchObject({ name: 'audio', playlist: 'hls/audio/index.m3u8' });
    expect(plan.args.join(' ')).toContain('-var_stream_map a:0,name:audio');
    expect(plan.args).toContain('-vn');
  });
  it('omits audio maps for silent video', () => {
    const plan = planHls({ ...video, hasAudio: false }, '/in.mp4', '/out', { threads: 2 });
    expect(plan.args.join(' ')).toContain(
      '-var_stream_map v:0,name:720p v:1,name:540p v:2,name:360p',
    );
    expect(plan.args).not.toContain('0:a:0');
  });
});
