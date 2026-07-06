// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: CC0-1.0

const path = require('path');
const webpack = require('webpack');

module.exports = {
  mode: 'production',
  entry: './src/index.js',
  output: {
    filename: 'webcomp-trains-realtime.min.js',
    path: path.resolve(__dirname, 'dist'),
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
  plugins: [
    new webpack.DefinePlugin({
      SIRI_BASE_URL: JSON.stringify(process.env.SIRI_BASE_URL),
    }),
  ],
};
