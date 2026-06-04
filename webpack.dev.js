// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: CC0-1.0

module.exports = {
  mode: 'development',
  entry: './src/index.js',
  output: {
    filename: 'webcomp-trains-realtime-sta.js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        type: 'asset/source',
      },
      {
        test: /\.(png|gif|jpg|jpeg|svg)$/i,
        type: 'asset/inline',
      },
    ],
  },
  devServer: {
    static: './public',
    port: 8998,
    hot: true,
  },
  devtool: 'inline-source-map',
};
