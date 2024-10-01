export function handleErrors(error: any) {
    if (error.message.includes('not enough tokens')) {
        console.error("Error: You don't have enough tokens.");
    } else if (error.message.includes('already disputed')) {
        console.error('Error: Proposal has already been disputed.');
    } else {
        console.error('An unexpected error occurred:', error);
    }
}