interface IRunningTools {
    [key: string]: {
        exclusive: boolean;
        exePath?: string;
        pid: number | undefined;
        started: number;
    }
}

export { IRunningTools };