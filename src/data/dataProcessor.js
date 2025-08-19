/**
 * Processes the data based on the provided dimensions and measures.
 * @param {Array} data - The raw data from the data binding.
 * @param {Array} dimensions - Array of dimension objects.
 * @param {Array} measures - Array of measure objects.
 */
export function processSeriesData(data, dimensions, measures) {
    const timeDimension = dimensions[0];
    const dimension = dimensions[1];
    const measure = measures[0];

    const structured = {};

    data.map(row => {
        const time = row[timeDimension.key].label;
        const category = row[dimension.key].label;
        const value = row[measure.key].raw;
        
        if (!structured[time]) {
            structured[time] = {};
        }
        structured[time][category] = value;
    });
    
    return structured;
    
}