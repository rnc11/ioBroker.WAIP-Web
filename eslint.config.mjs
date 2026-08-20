// ioBroker eslint template configuration file for js files
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // specify files to exclude from linting here
        ignores: ['.vscode/', '*.test.js', 'test/**/*.js', '*.config.mjs'],
    },
];
