import axios, { AxiosInstance } from "axios";
import { info } from "@actions/core";
import {
    listEnvVariables,
    patchEnvVariable,
    postEnvVariable,
    VercelEnvVariable,
    VercelEnvVariableTarget,
    VercelEnvVariableType,
} from "./vercel";

export const VALID_TYPES = ["encrypted", "plain"];

export const VALID_TARGETS: VercelEnvVariableTarget[] = [
    VercelEnvVariableTarget.Production,
    VercelEnvVariableTarget.Preview,
    VercelEnvVariableTarget.Development,
];

export default class VercelEnvVariabler {
    private envVariableKeys = new Array<string>();
    private vercelClient: AxiosInstance;

    private existingEnvVariables: Record<
        VercelEnvVariableTarget,
        Record<string, VercelEnvVariable>
    > = { production: {}, preview: {}, development: {} };

    constructor(
        private token: string,
        private projectName: string,
        envVariableKeysAsString: string,
        private teamId: string | undefined
    ) {
        const envVariableKeys = envVariableKeysAsString?.split(",");

        if (envVariableKeys?.length > 0) {
            this.envVariableKeys = envVariableKeys;
        }

        if (
            !this.token ||
            !this.projectName ||
            this.envVariableKeys.length === 0
        ) {
            throw new Error("Missing required input(s).");
        }

        this.vercelClient = axios.create({
            headers: {
                Authorization: `Bearer ${this.token}`,
            },
            baseURL: "https://api.vercel.com/v10",
            params: {
                teamId: this.teamId,
            },
        });
    }

    public async populateExistingEnvVariables(): Promise<void> {
        const envResponse = await listEnvVariables(
            this.vercelClient,
            this.projectName
        );

        const env = envResponse?.data?.envs;
        if (env) {
            info(`Found ${env.length} existing env variables`);

            for (const existingEnvVariable of env) {
                for (const existingTarget of existingEnvVariable.target) {
                    const preExistingVariablesForTarget =
                        this.existingEnvVariables[existingTarget] ?? {};
                    this.existingEnvVariables[existingTarget] = {
                        ...preExistingVariablesForTarget,
                        [existingEnvVariable.key]: existingEnvVariable,
                    };
                }
            }
        }
    }

    public async processEnvVariables(): Promise<void> {
        for (const envVariableKey of this.envVariableKeys) {
            await this.processEnvVariable(envVariableKey);
        }
    }

    private async processEnvVariable(envVariableKey: string) {
        const {
            value,
            targets,
            type,
            gitBranch,
        } = this.parseAndValidateEnvVariable(envVariableKey);

        info(JSON.stringify(this.existingEnvVariables));
        const existingVariables = targets.reduce((result, target) => {
            const existingVariable = this.existingEnvVariables?.[target]?.[
                envVariableKey
            ];

            if (existingVariable && existingVariable.gitBranch === gitBranch) {
                result[target] = existingVariable;
            }

            return result;
        }, {} as Record<VercelEnvVariableTarget, VercelEnvVariable>);

        const existingTargets = Object.keys(existingVariables);
        if (existingTargets.length === 0) {
            info(`No existing variable found for ${envVariableKey}, creating.`);
            info(`Gitbranch: ${gitBranch}`);
            await this.createEnvVariable({
                key: envVariableKey,
                value,
                targets,
                type,
                gitBranch,
            });
        } else {
            info(
                `Existing variable found for ${envVariableKey}, comparing values.`
            );
            await this.processPossibleEnvVariableUpdate({
                value,
                targets,
                type,
                gitBranch,
                existingVariables,
            });
        }
    }

    private parseAndValidateEnvVariable(
        envVariableKey: string
    ): {
        value: string;
        targets: VercelEnvVariableTarget[];
        type: VercelEnvVariableType;
        gitBranch: string | undefined;
    } {
        const value = process.env[envVariableKey];

        const targetString = process.env[`TARGET_${envVariableKey}`];
        const type = process.env[
            `TYPE_${envVariableKey}`
        ] as VercelEnvVariableType;
        const gitBranch = process.env[`GIT_BRANCH_${envVariableKey}`];

        if (!value) {
            throw new Error(
                `Variable ${envVariableKey} is missing env variable: ${envVariableKey}`
            );
        }
        if (!targetString) {
            throw new Error(
                `Variable ${envVariableKey} is missing env variable: ${`TARGET_${envVariableKey}`}`
            );
        }
        if (!type) {
            throw new Error(
                `Variable ${envVariableKey} is missing env variable: ${`TYPE_${envVariableKey}`}`
            );
        }
        if (!VALID_TYPES.includes(type)) {
            throw new Error(
                `No valid type found for ${envVariableKey}, type given: ${type}, valid types: ${VALID_TYPES.join(
                    ","
                )}`
            );
        }

        const targets = targetString
            .split(",")
            .filter((target) =>
                VALID_TARGETS.includes(target as VercelEnvVariableTarget)
            ) as VercelEnvVariableTarget[];

        if (
            gitBranch &&
            (targets.length !== 1 ||
                targets[0] !== VercelEnvVariableTarget.Preview)
        ) {
            throw new Error(
                'Only "preview" target is allowed when using gitBranch'
            );
        }

        if (targets.length === 0) {
            throw new Error(
                `No valid targets found for ${envVariableKey}, targets given: ${targetString}, valid targets: ${VALID_TARGETS.join(
                    ","
                )}`
            );
        }

        return { value, targets, type, gitBranch };
    }

    private async createEnvVariable({
        type,
        key,
        value,
        targets,
        gitBranch,
    }: {
        key: string;
        value: string;
        targets: VercelEnvVariableTarget[];
        type: VercelEnvVariableType;
        gitBranch: string | undefined;
    }) {
        const createResponse = await postEnvVariable(
            this.vercelClient,
            this.projectName,
            { type, key, value, target: targets, gitBranch }
        );

        if (!createResponse?.data) {
            info(
                `Variable ${key} with targets ${targets.join(
                    ","
                )} created successfully`
            );
        }
    }

    private async processPossibleEnvVariableUpdate({
        type,
        value,
        targets,
        existingVariables,
        gitBranch,
    }: {
        value: string;
        targets: VercelEnvVariableTarget[];
        type: VercelEnvVariableType;
        existingVariables: Record<VercelEnvVariableTarget, VercelEnvVariable>;
        gitBranch: string | undefined;
    }) {
        const existingVariable = Object.values(existingVariables)[0]; // They are all actually the same
        if (
            existingVariable.value !== value ||
            existingVariable.target.length !== targets.length ||
            existingVariable.type !== type ||
            existingVariable.gitBranch !== gitBranch
        ) {
            info(
                `Value, target, type or gitBranch for env variable ${existingVariable.key} has found to have changed, updating value`
            );
            const patchResponse = await patchEnvVariable(
                this.vercelClient,
                this.projectName,
                existingVariable.id,
                { type, value, target: targets, gitBranch }
            );
            if (patchResponse?.data) {
                info(`${existingVariable.key} updated successfully.`);
            }
        } else {
            info(`No change found for ${existingVariable.key}, skipping...`);
        }
    }
}
