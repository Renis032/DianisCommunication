(function () {
  async function decode(bytes, mime, { maxSize = 280 } = {}) {
    const decoder = new ImageDecoder({ data: bytes, type: mime || 'image/gif' });
    try {
      await decoder.tracks.ready;
      await decoder.completed;
      const track = decoder.tracks.selectedTrack;
      const count = Math.max(1, track ? track.frameCount : 1);
      const frames = [];
      let canvas = null;
      let ctx = null;
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        if (!canvas) {
          const scale = Math.min(1, maxSize / Math.max(image.displayWidth, image.displayHeight));
          canvas = new OffscreenCanvas(
            Math.max(1, Math.round(image.displayWidth * scale)),
            Math.max(1, Math.round(image.displayHeight * scale))
          );
          ctx = canvas.getContext('2d');
        }
        let delay = (image.duration || 0) / 1000;
        if (!delay || delay <= 10) delay = 100;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        frames.push({ bitmap: await createImageBitmap(canvas), delay });
      }
      return { width: canvas.width, height: canvas.height, frames };
    } finally {
      decoder.close();
    }
  }

  class GifPlayer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.anim = null;
      this.index = 0;
      this.timer = null;
      this.loops = 0;
      this.onLoop = null;
    }

    async load(bytes, mime, options) {
      this.stop();
      const anim = await decode(bytes, mime, options);
      this.anim = anim;
      this.canvas.width = anim.width;
      this.canvas.height = anim.height;
      this.index = 0;
      this.loops = 0;
      this.play();
      return anim;
    }

    totalDuration() {
      return this.anim ? this.anim.frames.reduce((s, f) => s + f.delay, 0) : 0;
    }

    play() {
      if (!this.anim) return;
      const frame = this.anim.frames[this.index];
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(frame.bitmap, 0, 0);
      if (this.anim.frames.length < 2) return;
      this.timer = setTimeout(() => {
        this.index = (this.index + 1) % this.anim.frames.length;
        if (this.index === 0) {
          this.loops++;
          if (this.onLoop) this.onLoop(this.loops);
        }
        this.play();
      }, frame.delay);
    }

    stop() {
      clearTimeout(this.timer);
      this.timer = null;
    }

    dispose() {
      this.stop();
      if (this.anim) this.anim.frames.forEach((f) => f.bitmap.close());
      this.anim = null;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  window.GifPlayer = GifPlayer;
})();
