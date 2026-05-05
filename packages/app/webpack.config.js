const path = require('path');

module.exports = {
  mode: 'production',
  target: 'electron-main',
  devtool: 'source-map',
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.ts', '.tsx'],
  },
  entry: './dist/main.js',
  output: {
    filename: 'main.bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  externals: {
    noobs: 'commonjs2 noobs',
    'better-sqlite3': 'commonjs2 better-sqlite3',
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
        },
      },
      {
        test: /\.node$/,
        use: {
          loader: 'node-loader',
        },
      },
    ],
  },
};
