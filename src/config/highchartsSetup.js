import * as Highcharts from 'highcharts';

/**
 * Applies Highcharts global options
 */
export function applyHighchartsDefaults() {
    Highcharts.setOptions({
        lang: {
            thousandsSep: ','
        },
        colors: ['#004b8d']
    });
}