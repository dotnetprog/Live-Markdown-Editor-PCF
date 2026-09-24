const SpeedMeasurePlugin = require('speed-measure-webpack-plugin')
const {
    default: FluentUIReactIconsFontSubsettingPlugin,
} = require('@fluentui/react-icons-font-subsetting-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')
const smp = new SpeedMeasurePlugin()
const MinimizerPlugin = require("minimizer-webpack-plugin");
module.exports = smp.wrap({
    plugins: [
        // insert other plugin code
        new CleanWebpackPlugin(),
    ],
    optimization: {
        minimize: true,
        minimizer: [new MinimizerPlugin()],
    },
})
