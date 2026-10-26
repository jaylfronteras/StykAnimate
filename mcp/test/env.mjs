// Loaded before the suite so every platform forces the built-in rasterizer.
// npm scripts on Windows cannot use a POSIX `STYK_RENDER=software node` prefix.
process.env.STYK_RENDER = 'software';
