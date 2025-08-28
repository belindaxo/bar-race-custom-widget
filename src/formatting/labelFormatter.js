import * as Highcharts from 'highcharts';
/**
 * Formats data labels based on the selected scale format.
 * @param {Function} scaleFormat - A function that formats values.
 * @returns {Function} A formatter function for data labels.
 */
export function formatDataLabels(scaleFormat) {
    return function () {
        const rawValue = this.rawValue;
        const { scaledValue, valueSuffix } = scaleFormat(rawValue);
        const value = Highcharts.numberFormat(scaledValue, -1, '.', ',');
        return `${value}`;
    }
}