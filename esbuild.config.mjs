import esbuild from 'esbuild';

const config = {
    entryPoints: [
        'src/main.ts'
    ],
    bundle: true,
    external: ['obsidian'],
    outfile: 'dist/main.js',
    platform: 'browser',
    format: 'cjs',
    sourcemap: false,
    minify: false,  // No minification for debugging
};

esbuild.build(config).then(() => {
    console.log('Build complete');
});
