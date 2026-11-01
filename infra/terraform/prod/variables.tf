variable "region" {
  type    = string
  default = "us-east-1"
}

variable "blueprint_id" {
  type    = string
  default = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "small_3_0: 2 GB RAM, 2 vCPU, 60 GB SSD"
  type        = string
  default     = "small_3_0"
}

variable "key_pair_name" {
  description = "Existing Lightsail key pair whose private key is stored in riff/prod/deploy"
  type        = string
  default     = "riff-deploy"
}

variable "streamers" {
  description = "One isolated Riff instance per name, served at https://<name>.<base domain>"
  type        = list(string)

  validation {
    condition     = length(var.streamers) <= 5 && length(distinct(var.streamers)) == length(var.streamers)
    error_message = "Use at most 5 distinct streamer names."
  }
  validation {
    condition     = alltrue([for name in var.streamers : can(regex("^[a-z][a-z0-9-]{0,19}$", name))])
    error_message = "Names use a-z, 0-9 and -, start with a letter, and are at most 20 characters."
  }
}
