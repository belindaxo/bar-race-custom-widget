/**
 * Processes the data based on the provided dimensions and measures.
 * @param {Array} data - The raw data from the data binding.
 * @param {Array} dimensions - Array of dimension objects.
 * @param {Array} measures - Array of measure objects.
 * @param {number} topN - The number of top items to return.
 * @returns {Object} An object containing a categories array and a sorted data array in descending order.
 */
export function processSeriesData(data, dimensions, measures, topN) {
    const dimension = dimensions[0];
    const timeDimension = dimensions[1];
    const measure = measures[0];

    const seriesData = data.map(row => {
        const category = row[dimension.key]?.label || 'No Label';
        const date = row[timeDimension.key]?.label || 'No Date';
        const value = row[measure.key]?.raw ?? 0;
        return { 
            category: category,
            categoryData: {
                date: date,
                value: value
            }
        }
    });

    const sortedData = seriesData.sort((a, b) => b.categoryData.value - a.categoryData.value);

    const topNFilter = parseInt(topN);
    if (!isNaN(topNFilter) && topNFilter > 0) {
        const filteredData = sortedData.slice(0, topNFilter);
        const categories = filteredData.map(item => item.category);
        const values = filteredData.map(item => item.categoryData.value);
        const dates = filteredData.map(item => item.categoryData.date);
        return {
            categories: categories,
            data: values,
            dates: dates
        }
    }

    

    
}