/** How often a file or socket store of the tests asks again for a key. */
export const pollInterval = 10;

/** How long a waiting caller is given to (wrongly) enter an occupied lock. */
export const settle = pollInterval * 5;
